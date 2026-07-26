"""carfox DittoVideoService — our own avatar engine as a Pipecat video service.

Pattern-matched to pipecat.services.simli.video.SimliVideoService, but the
engine is local: Ditto (Ant Group) running on this box's A100.

Audio contract: consumes the bot's TTS/S2S audio (TTSAudioRawFrame, any rate),
resamples to 16k, and feeds the SDK a CONTINUOUS 16k stream (silence when the
bot isn't speaking → natural idle motion, and the pipeline stays primed).
Emits paired OutputImageRawFrame (512² RGB) + TTSAudioRawFrame (16k) batches;
the output transport does all pacing and A/V sync.
"""

import asyncio
import os
import queue
import sys
import threading
import time
from collections import deque

import numpy as np
import cv2
from loguru import logger

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    OutputImageRawFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.ai_service import AIService

from av.audio.frame import AudioFrame
from av.audio.resampler import AudioResampler

DITTO_ROOT = os.environ.get("DITTO_ROOT", os.path.expanduser("~/ditto-talkinghead"))
if DITTO_ROOT not in sys.path:
    sys.path.insert(0, DITTO_ROOT)

CHUNK_FRAMES = (3, 5, 2)
WINDOW = 640 * sum(CHUNK_FRAMES)   # 6400 samples @16k  (engine context)
HOP = 640 * CHUNK_FRAMES[1]        # 3200 samples = 200ms = 5 video frames
# The lip model needs 16k (hubert), but Gemini speaks at 24k. Downsampling the
# PLAYOUT to 16k threw away half the spectrum and then Daily resampled again to
# 48k for Opus -- audibly muffled. So: 16k drives the lips, PLAY_SR is what the
# visitor actually hears.
PLAY_SR = int(os.environ.get("FOX_PLAY_SR", "24000"))
HOP_P = PLAY_SR // 5               # samples of playout audio per 200ms hop
HOP_P_BYTES = HOP_P * 2

# ---------------------------------------------------------------------------
# TRACE: every 200ms window of speech gets an id and is timestamped at each
# stage (fed to engine -> frames emerged -> played out). That turns "there's
# delay and the mouth is off" into a number per stage, and makes broken
# audio<->frame pairing impossible to miss.
# Inspect: GET /api/trace (JSON) or watch the "TURN" lines in the journal.
# ---------------------------------------------------------------------------
TRACE = deque(maxlen=4000)
TRACE_LOCK = threading.Lock()
COUNTERS = {
    "windows_fed": 0, "windows_emitted": 0, "windows_played": 0,
    "batches_consumed": 0, "idle_audio_dropped": 0, "speech_audio_dropped": 0,
    "frames_published": 0, "playout_underruns": 0, "interruptions": 0,
    # video clock health: a dup means the camera device was handed the same
    # frame twice, a skip means a generated frame was never displayed.
    "video_writes": 0, "video_dup_writes": 0, "video_skipped_frames": 0,
    "video_keepalive_writes": 0,
    # master-clock health: tick spacing should sit at 40ms.
    "tick_jitter_ms_p95": 0.0, "tick_jitter_ms_max": 0.0, "rec_frames_dropped": 0,
    "pair_drift": 0,   # windows_emitted - batches_consumed; MUST stay 0
}


def trace(event, **kw):
    with TRACE_LOCK:
        TRACE.append({"t": round(time.time(), 3), "ev": event, **kw})


def trace_snapshot(limit=400):
    with TRACE_LOCK:
        return {"counters": dict(COUNTERS), "events": list(TRACE)[-limit:]}


_sdk = None
_sdk_lock = threading.Lock()
_active_owner = None  # the service instance currently driving the SDK


def get_sdk():
    """Load the Ditto StreamSDK once per process (models ~30s)."""
    global _sdk
    with _sdk_lock:
        if _sdk is None:
            from stream_pipeline_online import StreamSDK

            class BridgedSDK(StreamSDK):
                def bridge_reset(self):
                    self.frame_out = queue.Queue()
                    self.frames_written = 0

                def _writer_worker(self):
                    while not self.stop_event.is_set():
                        try:
                            item = self.writer_queue.get(timeout=1)
                        except queue.Empty:
                            continue
                        if item is None:
                            break
                        # index every frame: warmup output arrives LATE (the GPU
                        # workers run behind run_chunk), so it can only be
                        # separated from session output by count, not by drain.
                        self.frame_out.put((self.frames_written, item))
                        self.frames_written += 1

            _sdk = BridgedSDK(
                os.path.join(DITTO_ROOT, "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"),
                os.path.join(DITTO_ROOT, "checkpoints/ditto_pytorch"),
            )
            logger.info("ditto-pipecat: StreamSDK loaded")
    return _sdk


class DittoVideoService(AIService):
    def __init__(self, *, source_path: str, **kwargs):
        super().__init__(**kwargs)
        self._source_path = source_path
        # playout stream at PLAY_SR (what the visitor hears) and a single
        # continuous resampler that derives the engine's 16k feed from it, so
        # the two can never drift apart.
        self._to_play = AudioResampler("s16", "mono", PLAY_SR)
        self._to16 = AudioResampler("s16", "mono", 16000)
        self._play = deque()            # pending PLAY_SR s16 bytes (playout)
        self._speech = deque()          # kept for the SmallWebRTC fallback
        self._speech_lock = threading.Lock()
        self._feeder_thread_h = None
        self._emitter_thread_h = None
        self._emitter_task = None
        self._boot_task = None
        self._stopping = False
        # direct-to-device audio (Daily): emitter fills, writer thread drains.
        # Audio written through the pipeline (ANY chunking/pacing) makes
        # daily-python discard all video; a plain-thread device writer — the
        # bare-probe pattern — coexists with video perfectly.
        self._audio_sink_getter = None
        self._audio_out = deque()  # (audio_bytes|None, [frame_bytes x5]|None) per hop
        self._ledger = deque()     # fed window k -> (audio_bytes, is_speech)
        self._base = 0             # writer frame index where real output begins
        self._frame_setter = None  # Daily path: writer clocks frames to audio
        self._last_speech_t = 0.0  # feeder: last time a speech hop was fed
        # Rolling session recording (what the visitor actually receives).
        rec_secs = int(os.environ.get("FOX_RECORD_SECS", "90"))
        self._rec_on = os.environ.get("FOX_RECORD_SESSIONS", "1") == "1"
        self._rec_ring = deque(maxlen=rec_secs * 25) if self._rec_on else None
        self._rec_lock = threading.Lock()
        self._last_audio_t = 0.0   # feeder: last time Gemini audio arrived

    def set_audio_sink_getter(self, getter):
        """Daily path: write audio straight to the mic device from a thread."""
        self._audio_sink_getter = getter
        threading.Thread(target=self._audio_writer_thread, daemon=True).start()

    def _audio_writer_thread(self):
        """Master A/V clock (Daily path): every 40ms tick writes one audio
        slice AND publishes the frame generated for exactly that 40ms —
        lip-sync holds by construction, at playback time, regardless of how
        far ahead the GPU runs."""
        import time as _time
        slice_bytes = HOP_P_BYTES // 5      # 40ms of s16 @ PLAY_SR
        silence = b"\x00" * slice_bytes
        pending = deque()                    # (audio_slice, frame_bytes|None)
        deadline = _time.perf_counter()
        sink = None
        # carfox: clock jitter — record how far each tick strays from 40ms.
        self._ticks_ms = deque(maxlen=2000)
        self._last_tick = None
        if self._rec_ring is not None and not hasattr(self, "_rec_q"):
            self._rec_q = queue.Queue(maxsize=50)
            threading.Thread(target=self._rec_encoder_thread, daemon=True).start()
        while not self._stopping:
            now_t = _time.perf_counter()
            if self._last_tick is not None:
                self._ticks_ms.append(abs((now_t - self._last_tick) * 1000.0 - 40.0))
                if len(self._ticks_ms) % 100 == 0:
                    j = sorted(self._ticks_ms)
                    COUNTERS["tick_jitter_ms_p95"] = round(j[int(len(j) * 0.95)], 2)
                    COUNTERS["tick_jitter_ms_max"] = round(j[-1], 2)
            self._last_tick = now_t
            if sink is None:
                sink = self._audio_sink_getter() if self._audio_sink_getter else None
                if sink is None:
                    _time.sleep(0.1)
                    deadline = _time.perf_counter()
                    continue
            # CUSHION: eagerly drain every ready window into `pending`. The
            # engine emits ~70 frames in a burst then pauses; pulling one
            # window at a time let playback starve between bursts (~50% of the
            # voice went to silence). Draining the whole burst into pending and
            # pre-rolling ~1s of it means the gaps between bursts are already
            # buffered — continuous audio, continuous lips.
            if not pending and self._audio_out:
                # Skip stale IDLE windows (audio=None) when the queue runs deep
                # so a reply never waits behind buffered idle; speech is never
                # skipped. Then expand one window into 5 aligned 40ms ticks.
                audio, frames, wid = self._audio_out.popleft()
                while audio is None and len(self._audio_out) > 3:
                    audio, frames, wid = self._audio_out.popleft()
                for j in range(5):
                    pending.append((
                        audio[j * slice_bytes : (j + 1) * slice_bytes] if audio else silence,
                        frames[j] if frames else None,
                        wid if audio else -1,   # window id, for the trace
                    ))
            # JITTER CUSHION: the engine delivers ~1.2s bursts, so playing the
            # instant a window lands leaves the buffer dry between bursts and
            # injects 40-80ms silences MID-WORD -- audible as clicks/static
            # (measured: quiet runs of 1-2 frames inside speech). Hold until a
            # small cushion exists, then play continuously; on an underrun,
            # re-cushion once rather than stuttering every burst.
            if not hasattr(self, "_cushion"):
                self._cushion = int(os.environ.get("FOX_CUSHION_TICKS", "6"))  # 240ms
                self._debt = self._cushion      # build the cushion before first play
                self._underruns = 0
            if not pending:
                # dry: if we were mid-stream this is an underrun -- take on debt
                # so the queue can rebuild instead of gapping every burst.
                if self._debt == 0:
                    self._debt = self._cushion
                    self._underruns += 1
                    if self._underruns % 10 == 1:
                        logger.info(f"ditto-pipecat: playout underrun #{self._underruns}, re-cushioning")
                piece, fb = silence, None
            elif self._debt > 0:
                # hold playback (silence) while `pending` grows to the cushion.
                # Production and playback are balanced, so a cushion only exists
                # if we deliberately fall behind ONCE -- gating on depth alone
                # could never accumulate it and played pure silence.
                self._debt -= 1
                piece, fb = silence, None
            else:
                piece, fb, pw = pending.popleft()
                if pw > 0:
                    COUNTERS["windows_played"] += 1
                    if not getattr(self, "_play_utt_open", False):
                        self._play_utt_open = True
                        trace("play_speech_start", wid=pw, pending=len(pending))
                elif getattr(self, "_play_utt_open", False):
                    self._play_utt_open = False
            # audio sits ~200ms deeper in the playout chain (mic buffer +
            # jitter buffer) than video — delay frame publishing a few ticks
            # so lips land ON the voice, not ahead of it (measured -200ms)
            if not hasattr(self, "_fb_delay"):
                self._fb_delay = deque()
                self._fb_ticks = int(os.environ.get("FOX_AV_OFFSET_TICKS", "5"))
                self._last_pub = None
                self._rec = [] if os.environ.get("FOX_RECORD") == "1" else None
            self._fb_delay.append(fb)
            fb_now = self._fb_delay.popleft() if len(self._fb_delay) > self._fb_ticks else None
            if fb_now is not None:
                self._last_pub = fb_now
            try:
                sink.write_frames(piece)
                if fb_now is not None and self._frame_setter is not None:
                    self._frame_setter(fb_now)
                    COUNTERS["frames_published"] += 1
                self._awrites = getattr(self, "_awrites", 0) + 1
                if self._awrites % 500 == 1:
                    logger.info(f"ditto-pipecat: audio device writes {self._awrites}")
                # GROUND-TRUTH RECORDING: exactly what is transmitted this
                # 40ms tick — the audio slice + the frame on screen with it.
                if self._rec is not None and len(self._rec) < 900:
                    self._rec.append((piece, self._last_pub))
                    if len(self._rec) == 900:
                        self._flush_recording()
                # Rolling ring for the whole session. carfox: the JPEG encode
                # runs on a BACKGROUND thread -- doing it here spent several ms
                # of every 40ms tick on the clock that paces both media tracks.
                if self._rec_ring is not None:
                    try:
                        self._rec_q.put_nowait((piece, fb_now))
                    except queue.Full:
                        COUNTERS["rec_frames_dropped"] += 1
            except Exception:
                logger.exception("ditto-pipecat: AUDIO WRITER DIED")
                return
            deadline += 0.04
            rest = deadline - _time.perf_counter()
            if rest > 0:
                _time.sleep(rest)
            elif rest < -1.0:
                deadline = _time.perf_counter()

    def _rec_encoder_thread(self):
        """JPEG-encode captured frames off the master clock."""
        q_ = self._rec_q
        while not self._stopping:
            try:
                piece, fb = q_.get(timeout=1)
            except queue.Empty:
                continue
            jpg = None
            if fb is not None:
                try:
                    arr = np.frombuffer(fb, dtype=np.uint8).reshape(512, 512, 3)
                    ok, enc = cv2.imencode(
                        ".jpg", arr[:, :, ::-1],
                        [int(cv2.IMWRITE_JPEG_QUALITY), int(os.environ.get("FOX_RECORD_Q", "55"))],
                    )
                    jpg = enc.tobytes() if ok else None
                except Exception:
                    jpg = None
            with self._rec_lock:
                self._rec_ring.append((piece, jpg))

    def dump_session_recording(self, path):
        """Mux the rolling ring to `path` (mp4). Returns the path or None."""
        if not self._rec_ring:
            return None
        import shutil
        import subprocess
        import tempfile

        with self._rec_lock:
            ring = list(self._rec_ring)
        if not ring:
            return None
        tmp = tempfile.mkdtemp(prefix="foxrec-")
        try:
            audio_path = os.path.join(tmp, "a.raw")
            n_frames, last = 0, None
            with open(audio_path, "wb") as fa:
                for piece, jpg in ring:
                    fa.write(piece)
                    # hold the previous frame when a tick published none, so
                    # audio and video stay aligned tick-for-tick
                    use = jpg if jpg is not None else last
                    if use is None:
                        continue
                    last = use
                    with open(os.path.join(tmp, f"{n_frames:06d}.jpg"), "wb") as ff:
                        ff.write(use)
                    n_frames += 1
            if n_frames < 5:
                return None
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-framerate", "25", "-i", os.path.join(tmp, "%06d.jpg"),
                 "-f", "s16le", "-ar", str(PLAY_SR), "-ac", "1", "-i", audio_path,
                 "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-shortest", path],
                check=True, capture_output=True, timeout=180,
            )
            logger.info(f"ditto-pipecat: session recording -> {path} ({n_frames/25:.1f}s)")
            return path
        except Exception:
            logger.exception("ditto-pipecat: session recording failed")
            return None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _flush_recording(self):
        """Mux the tick-aligned (audio, on-screen-frame) log into an mp4 —
        exactly the A/V relationship transmitted. FOX_RECORD=1 only."""
        import subprocess
        try:
            black = b"\x00" * (512 * 512 * 3)
            with open("/tmp/fox_rec_audio.raw", "wb") as fa, open("/tmp/fox_rec_video.raw", "wb") as fv:
                for piece, frame in self._rec:
                    fa.write(piece)
                    fv.write(frame if frame is not None else black)
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "/tmp/fox_rec_audio.raw",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "512x512", "-r", "25", "-i", "/tmp/fox_rec_video.raw",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                "/tmp/fox_rec.mp4",
            ], check=True, capture_output=True)
            logger.info(f"ditto-pipecat: RECORDING flushed -> /tmp/fox_rec.mp4 ({len(self._rec)} ticks)")
        except Exception:
            logger.exception("ditto-pipecat: recording flush failed")
        self._rec = None

    async def start(self, frame: StartFrame):
        await super().start(frame)
        # NON-BLOCKING boot: StartFrame must reach the transport within
        # ~seconds of the room join or Daily's announced-but-frameless
        # camera track goes permanently dormant (the root cause of the
        # one-keyframe-then-black calls). The pacer downstream streams the
        # avatar's still photo while the engine primes here in the background.
        if self._boot_task is None:
            self._boot_task = asyncio.create_task(self._boot())

    async def _boot(self):
        sdk = get_sdk()
        loop = asyncio.get_running_loop()

        def _setup():
            if hasattr(sdk, "stop_event"):
                try:
                    sdk.stop_event.set()
                    for t in getattr(sdk, "thread_list", []):
                        t.join(timeout=4)
                except Exception as e:
                    logger.warning(f"ditto-pipecat: prev teardown: {e}")
            try:
                sdk.stop_event.clear()  # a set flag from the previous
                # session's teardown makes the fresh workers exit after a
                # few batches (burn stalls, fox goes silent)
            except Exception:
                pass
            sdk.bridge_reset()
            sdk.setup(
                self._source_path,
                "/tmp/ditto_pipecat_unused.mp4",
                online_mode=True,
                sampling_timesteps=int(os.environ.get("DITTO_STEPS", "10")),
                max_size=1024,
                # Emit motion clips more often (valid_clip_len = 80 - overlap).
                # Measured: overlap 10 -> the engine holds ~145 frames (5.8s)
                # in flight; overlap 50 -> ~70 frames (2.8s), i.e. ~3s off
                # every reply, at no throughput cost (24.9 vs 24.8 fps).
                overlap_v2=int(os.environ.get("FOX_OVERLAP", "50")),
            )
            # PRIME THE WARMUP HERE, behind the connection loader. The diffusion
            # needs ~30 windows (~6s of audio) before it emits its first frame;
            # if that happens live it buries the greeting. Feed silence at
            # GPU-max now and discard the warmup output, so once the real
            # session starts, output flows within one burst (~2-3s) instead.
            warm_windows = int(os.environ.get("FOX_WARM_WINDOWS", "45"))
            dummy = np.zeros(WINDOW, dtype=np.float32)
            for _ in range(warm_windows):
                if self._stopping:
                    return
                sdk.run_chunk(dummy, chunksize=CHUNK_FRAMES)
            # These windows WILL each yield exactly 5 frames, but arrive late.
            # Skip them by index so session audio pairs with session frames —
            # draining here can't work (output only flows under input pressure)
            # and leaving them unpaired shifts every lip against its voice.
            self._skip = warm_windows * CHUNK_FRAMES[1]
            logger.info(
                f"ditto-pipecat: warmup primed ({warm_windows} windows); "
                f"skipping frame indices <{self._skip}"
            )

        global _active_owner
        _active_owner = self
        try:
            await loop.run_in_executor(None, _setup)
        except Exception:
            logger.exception("ditto-pipecat: ENGINE BOOT FAILED")
            return
        if self._stopping:
            return
        logger.info(f"ditto-pipecat: avatar ready ({self._source_path})")
        self._feeder_thread_h = threading.Thread(target=self._feeder_thread, args=(sdk,), daemon=True)
        self._feeder_thread_h.start()
        self._emitter_thread_h = threading.Thread(target=self._emitter_thread, args=(sdk,), daemon=True)
        self._emitter_thread_h.start()

    async def stop(self, frame: EndFrame):
        await super().stop(frame)
        await self._shutdown()

    async def cancel(self, frame: CancelFrame):
        await super().cancel(frame)
        await self._shutdown()

    async def _shutdown(self):
        self._stopping = True
        if self._boot_task is not None and not self._boot_task.done():
            self._boot_task.cancel()
        sdk = get_sdk()
        # Only tear down SDK workers if WE still own them — a newer session
        # may have already re-setup the shared SDK (cancel/teardown race).
        if _active_owner is self:
            try:
                sdk.stop_event.set()
            except Exception:
                pass
        # emitter is a daemon thread now; it exits when _stopping is set

    # ---- engine drive ----------------------------------------------------

    def _feeder_thread(self, sdk):
        """Dedicated generation thread: its own metronome, blocking GPU calls,
        zero asyncio contention. One 200ms hop per 200ms of wall time — the
        GPU work happens INSIDE the budget, sleep covers the remainder."""
        import time as _time
        buf = np.zeros(0, dtype=np.float32)   # engine feed @16k
        bufP = bytearray()                    # playout @PLAY_SR
        pendingP = deque()                    # one playout hop per engine hop
        self._ledger = deque()
        deadline = _time.perf_counter()
        while not self._stopping:
            # Drain ALL pending Gemini audio at once (not one chunk per tick)
            # so an utterance stays contiguous.
            with self._speech_lock:
                chunks = list(self._play)
                self._play.clear()
            if chunks:
                self._last_audio_t = _time.perf_counter()
                bufP.extend(b"".join(chunks))
            # NEVER pad silence mid-utterance. Gemini streams speech in small
            # 20-100ms chunks, so the buffer is often short of a full 400ms
            # window while the fox is still talking. Padding to complete the
            # window injected whole 200ms silence hops INTO sentences —
            # measured as quiet runs of exactly 5 frames (1 hop) covering ~50%
            # of the greeting, vs 17% natural pauses in reference speech. It
            # shredded the voice AND made the engine draw a closed mouth on
            # those hops. Wait for the rest of the utterance; only once audio
            # has genuinely stopped for 400ms do we feed idle silence (which
            # keeps the face alive and flushes the tail).
            # Convert whole playout hops into the engine's 16k stream through ONE
            # continuous resampler: each 200ms hop yields exactly HOP samples, so
            # the audio the visitor hears and the frames the model makes from it
            # stay locked together by construction.
            while len(bufP) >= HOP_P_BYTES:
                hop_play = bytes(bufP[:HOP_P_BYTES])
                del bufP[:HOP_P_BYTES]
                af = AudioFrame.from_ndarray(
                    np.frombuffer(hop_play, dtype=np.int16)[None, :], layout="mono"
                )
                af.sample_rate = PLAY_SR
                for rf in self._to16.resample(af):
                    buf = np.concatenate(
                        [buf, rf.to_ndarray().astype(np.float32).ravel() / 32768.0]
                    )
                pendingP.append(hop_play)

            if len(buf) < WINDOW:
                if _time.perf_counter() - self._last_audio_t < 0.4:
                    _time.sleep(0.01)
                    continue
                # idle: pad BOTH streams so they stay duration-matched
                buf = np.concatenate([buf, np.zeros(HOP, dtype=np.float32)])
                pendingP.append(b"\x00" * HOP_P_BYTES)
            fed = False
            while len(buf) >= WINDOW and not self._stopping:
                hop = buf[:HOP]
                window = buf[:WINDOW].copy()
                buf = buf[HOP:]
                # is_speech decides whether this window's AUDIO may be dropped
                # downstream, so a false "silence" during real speech deletes
                # sound while the mouth keeps moving -- the reported "avatar
                # talking but no audio / cut off slightly". Word tails, soft
                # consonants and inter-word pauses routinely fall under a bare
                # amplitude test, so use a lower trigger plus HANGOVER: once an
                # utterance starts, keep the whole thing marked as speech until
                # it has been quiet for FOX_SPEECH_HANG windows (default 2s).
                # LATENCY: hangover must be SHORT. At 10 windows (2s) every
                # utterance kept 2s of trailing silence marked as speech, so it
                # was queued for playout instead of dropped -- the next reply had
                # to wait behind it, adding up to 2s per turn. 2 windows (400ms)
                # still protects word tails without queueing dead air. Pair it
                # with a lower trigger so quiet consonants register as speech.
                loud = float(np.sqrt(np.mean(hop * hop))) > 0.002
                if loud:
                    self._hang = int(os.environ.get("FOX_SPEECH_HANG", "2"))
                elif getattr(self, "_hang", 0) > 0:
                    self._hang -= 1
                is_speech = loud or getattr(self, "_hang", 0) > 0
                if is_speech:
                    self._last_speech_t = _time.perf_counter()
                hop_out = pendingP.popleft() if pendingP else (b"\x00" * HOP_P_BYTES)
                self._wid = getattr(self, "_wid", 0) + 1
                self._ledger.append((hop_out, is_speech, self._wid))
                COUNTERS["windows_fed"] += 1
                if is_speech and not getattr(self, "_utt_open", False):
                    self._utt_open = True
                    trace("fed_speech_start", wid=self._wid, ledger=len(self._ledger))
                elif not is_speech and getattr(self, "_utt_open", False) and getattr(self, "_hang", 0) == 0:
                    self._utt_open = False
                t0 = _time.perf_counter()
                sdk.run_chunk(window, chunksize=CHUNK_FRAMES)  # blocking; CUDA releases the GIL
                dt = _time.perf_counter() - t0
                self._hop_ms = getattr(self, "_hop_ms", 0.0) * 0.9 + dt * 1000 * 0.1
                self._hops = getattr(self, "_hops", 0) + 1
                if self._hops % 25 == 1:
                    # QUEUE CENSUS: latency compounds per turn, so watch every
                    # buffer that could be growing. ledger = fed-not-yet-emitted
                    # (engine depth); avq = emitted-not-yet-played (playout);
                    # pend = playout hops staged in the feeder.
                    logger.info(
                        f"ditto-pipecat: pace {self._hop_ms:.0f}ms | ledger={len(self._ledger)} "
                        f"avq={len(self._audio_out)} pendP={len(pendingP)} bufP={len(bufP)//HOP_P_BYTES} "
                        f"buf16={len(buf)//HOP} speech_q={len(self._play)}"
                    )
                fed = True
                # Feed at realtime. (Feeding faster only helps if the consumer
                # can drain faster; with the emitter now on its own thread it
                # sustains realtime, and realtime-in keeps the ledger bounded.)
                deadline += 0.2
                rest = deadline - _time.perf_counter()
                if rest > 0:
                    _time.sleep(rest)
                elif rest < -1.0:
                    deadline = _time.perf_counter()
            if not fed:
                _time.sleep(0.02)
                deadline = _time.perf_counter()

    def _to_bytes(self, frames5):
        if not getattr(self, "_shape_logged", False) and frames5:
            self._shape_logged = True
            logger.info(
                f"ditto-pipecat: engine frame shape {frames5[0].shape} "
                f"(resize needed: {frames5[0].shape[:2] != (512, 512)})"
            )
        out = []
        for f in frames5:
            img = f if f.shape[2] == 3 else f[:, :, :3]
            if img.shape[:2] != (512, 512):
                img = cv2.resize(img, (512, 512))
            out.append(np.ascontiguousarray(img).tobytes())
        return out

    def _emitter_thread(self, sdk):
        """Dedicated thread (NOT the event loop). Pairs each finished 5-frame
        batch with its audio window (strict FIFO, probe-verified: the engine
        never drops or reorders), sheds idle backlog pairing-safely, and hands
        (audio, frames) to the audio-writer. Runs off the event loop because
        as an async task it was starved by the Daily transport + Gemini socket
        and could not keep pace with the engine -> unbounded backlog -> the
        greeting buried tens of seconds deep. A plain thread sustains the full
        output rate, so the ledger stays near TARGET and latency stays low."""
        TARGET = int(os.environ.get("FOX_LEDGER_TARGET", "6"))
        try:
            while not self._stopping:
                # block for one batch (5 frames)
                frames5 = []
                while not self._stopping:
                    try:
                        idx, fr = sdk.frame_out.get(timeout=1)
                    except queue.Empty:
                        continue
                    if idx < getattr(self, "_skip", 0):
                        continue  # warmup frame — no session audio belongs to it
                    frames5.append(fr)
                    if len(frames5) == CHUNK_FRAMES[1]:
                        break
                if self._stopping:
                    return
                hop, is_sp, wid = (
                    self._ledger.popleft() if self._ledger else (b"\x00" * HOP_P_BYTES, False, -1)
                )
                COUNTERS["batches_consumed"] += 1
                COUNTERS["windows_emitted"] += 1
                COUNTERS["pair_drift"] = COUNTERS["windows_emitted"] - COUNTERS["batches_consumed"]
                if not getattr(self, "_primed", False):
                    # Mark primed on the FIRST batch of any kind. Gating this on
                    # a speech batch deadlocked the greeting: the greeting waits
                    # for primed, but speech only exists after the greeting, so
                    # it only ever fired via the 25s fallback.
                    self._primed = True
                    logger.info(f"ditto-pipecat: frames flowing (target depth {TARGET})")
                # PAIRING-SAFE CATCH-UP DRAIN: when deep, drop this silence pair
                # and rapidly sweep further buffered silence pairs (5 frames + 1
                # ledger each, always together) so pairing never shifts and only
                # silence is ever lost. Now that this runs on its own thread the
                # sweep actually keeps up with the engine.
                if len(self._ledger) > TARGET and not is_sp:
                    # Shed idle latency: this silence window's audio is dropped
                    # (it carries no words) but its FRAMES are still shown, so
                    # the face keeps breathing/blinking instead of freezing.
                    # audio=None marks it skippable in the writer.
                    COUNTERS["idle_audio_dropped"] += 1
                    self._emit_utt_open = False
                    self._audio_out.append((None, self._to_bytes(frames5), wid))
                    continue
                self._recv_batches = getattr(self, "_recv_batches", 0) + 1
                if self._recv_batches % 100 == 0:
                    logger.info(
                        f"ditto-pipecat: batch {self._recv_batches}, ledger={len(self._ledger)}, avq={len(self._audio_out)}"
                    )
                # Daily path: hand the writer this window's REAL audio + frames.
                # (SmallWebRTC fallback is not driven from this thread.)
                if is_sp and not getattr(self, "_emit_utt_open", False):
                    self._emit_utt_open = True
                    trace("emit_speech_start", wid=wid, ledger=len(self._ledger), avq=len(self._audio_out))
                elif not is_sp:
                    self._emit_utt_open = False
                self._audio_out.append((hop, self._to_bytes(frames5), wid))
        except Exception:
            logger.exception("ditto-pipecat: EMITTER THREAD DIED")

    # ---- pipecat plumbing ------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if "AudioRawFrame" in type(frame).__name__ and not isinstance(frame, TTSAudioRawFrame):
            if not getattr(self, "_odd_audio_logged", False):
                self._odd_audio_logged = True
                logger.warning(f"ditto-pipecat: NON-TTS audio frame passing through: {type(frame).__name__}")
        if isinstance(frame, TTSAudioRawFrame):
            if not getattr(self, "_tts_open", False):
                self._tts_open = True
                trace("gemini_audio_first", rate=frame.sample_rate)
            if not getattr(self, "_sr_logged", False):
                self._sr_logged = True
                logger.info(
                    f"ditto-pipecat: Gemini audio arrives at {frame.sample_rate}Hz "
                    f"x{frame.num_channels}ch (we resample to 16k for the lip model)"
                )
            try:
                if frame.sample_rate == PLAY_SR and frame.num_channels == 1:
                    # already the playout rate: pass through untouched (no loss)
                    chunks = [frame.audio]
                else:
                    af = AudioFrame.from_ndarray(
                        np.frombuffer(frame.audio, dtype=np.int16)[None, :],
                        layout="mono" if frame.num_channels == 1 else "stereo",
                    )
                    af.sample_rate = frame.sample_rate
                    chunks = [
                        rf.to_ndarray().astype(np.int16).tobytes()
                        for rf in self._to_play.resample(af)
                    ]
                for b in chunks:
                    with self._speech_lock:
                        self._play.append(b)
                    # FOX_RECORD_RAW=1: dump Gemini's audio exactly as it
                    # arrives (post-resample, pre-anything-of-ours) so its gap
                    # profile can be compared against what we transmit. Answers
                    # "are the holes ours or the model's?" without guessing.
                    if os.environ.get("FOX_RECORD_RAW") == "1":
                        try:
                            with open("/tmp/fox_raw_gemini.pcm", "ab") as fh:
                                fh.write(b)
                        except Exception:
                            pass
            except Exception as e:
                await self.push_error(error_msg=f"ditto audio in: {e}", exception=e)
            return  # engine audio comes back out paired with video
        if isinstance(frame, UserStartedSpeakingFrame):
            trace("user_started_speaking")
        if isinstance(frame, InterruptionFrame):
            COUNTERS["interruptions"] += 1
            trace("interruption", note="fox truncated; false ones come from mic echo")
        if isinstance(frame, (InterruptionFrame, UserStartedSpeakingFrame)):
            with self._speech_lock:
                self._speech.clear()
            if hasattr(self, "_ledger"):
                # mark queued speech hops as droppable silence
                self._ledger = deque(((h, False, w) for h, _, w in self._ledger))
        if isinstance(frame, TTSStoppedFrame):
            if getattr(self, "_tts_open", False):
                self._tts_open = False
                trace("gemini_audio_done")
            return
        await self.push_frame(frame, direction)


class FramePacer(FrameProcessor):
    """Re-clock video frames to a rock-steady cadence for Daily.

    daily-python's libwebrtc encoder stops producing packets when frames
    arrive with jittery or stalling timing (a bare 25fps metronome probe
    streamed perfectly while the pipeline's bursty supply froze after the
    first keyframe). This holds the newest OutputImageRawFrame and re-emits
    on a strict metronome, repeating the last image through gaps so the
    encoder never starves — which also keeps idle video continuous.
    """

    def __init__(self, fps: int = 25, initial_image_path: str | None = None, sink_getter=None):
        super().__init__()
        self._period = 1.0 / fps
        self._latest = None
        self._metronome_task = None
        self._initial_image_path = initial_image_path
        # Daily path: write frames straight to the camera device from a
        # plain thread. Event-loop-driven video writes are discarded by
        # daily-python whenever ANY audio is being written; thread-driven
        # writes (the bare-probe pattern) stream perfectly alongside audio.
        self._sink_getter = sink_getter
        self._writer_stop = False
        # carfox: single-clock video. _seq advances every time the audio clock
        # publishes a frame; _written_seq is what the device has actually seen.
        self._seq = 0
        self._written_seq = -1
        self._sink_ref = None
        self._direct = os.environ.get("FOX_SINGLE_CLOCK", "1") == "1"
        self._last_direct = 0.0

    def set_latest(self, fb):
        """Publish one 40ms tick's frame. Called from the audio writer thread,
        which is the master A/V clock -- in single-clock mode the write happens
        HERE, alongside that tick's audio, so every generated frame is shown
        exactly once."""
        self._latest = (fb, (512, 512), "RGB")
        self._seq += 1
        if not self._direct:
            return
        sink = self._sink_ref
        if sink is None:
            return
        try:
            sink.write_frame(fb)
            self._written_seq = self._seq
            self._last_direct = time.perf_counter()
            COUNTERS["video_writes"] += 1
        except Exception:
            logger.exception("ditto-pipecat: direct video write failed")

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            # seed with the avatar's still photo so the camera track carries
            # frames from the very first moment (a track that stays empty
            # for the ~15s engine prime never wakes Daily's encoder), and
            # the user sees the fox instantly instead of black
            if self._latest is None and self._initial_image_path:
                img = cv2.imread(self._initial_image_path)
                if img is not None:
                    img = cv2.resize(img, (512, 512))
                    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                    self._latest = (np.ascontiguousarray(img).tobytes(), (512, 512), "RGB")
            if self._sink_getter is not None:
                if self._metronome_task is None:
                    self._metronome_task = True
                    threading.Thread(target=self._writer_thread, daemon=True).start()
            elif self._metronome_task is None:
                self._metronome_task = asyncio.create_task(self._metronome())
            return
        if isinstance(frame, (EndFrame, CancelFrame)):
            self._writer_stop = True
            if self._metronome_task is not None and self._metronome_task is not True:
                self._metronome_task.cancel()
            self._metronome_task = None
            await self.push_frame(frame, direction)
            return
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, OutputImageRawFrame):
            self._latest = (frame.image, frame.size, frame.format)  # swallowed; the metronome re-emits
            return
        await self.push_frame(frame, direction)

    def _writer_thread(self):
        import time as _time

        deadline = _time.perf_counter()
        sink = None
        while not self._writer_stop:
            if sink is None:
                sink = self._sink_getter() if self._sink_getter else None
                if sink is None:
                    _time.sleep(0.1)
                    deadline = _time.perf_counter()
                    continue
                logger.info(f"ditto-pipecat: video sink resolved: {type(sink).__name__}")
                self._sink_ref = sink
            if self._direct:
                # carfox: single-clock -- the audio thread owns video timing.
                # Only cover gaps (idle, or before the engine primes) so the
                # encoder never starves on an empty track.
                if (time.perf_counter() - self._last_direct) > 0.2 and self._latest is not None:
                    try:
                        sink.write_frame(self._latest[0])
                        COUNTERS["video_keepalive_writes"] += 1
                    except Exception:
                        logger.exception("ditto-pipecat: VIDEO WRITER DIED")
                        return
            elif self._latest is not None:
                # two-clock path, kept so the beat stays measurable
                if self._seq == self._written_seq:
                    COUNTERS["video_dup_writes"] += 1
                elif self._seq - self._written_seq > 1:
                    COUNTERS["video_skipped_frames"] += self._seq - self._written_seq - 1
                self._written_seq = self._seq
                img, _size, _fmt = self._latest
                try:
                    sink.write_frame(img)
                    COUNTERS["video_writes"] += 1
                    self._writes = getattr(self, "_writes", 0) + 1
                    if self._writes % 250 == 1:
                        logger.info(f"ditto-pipecat: video device writes {self._writes}")
                except Exception:
                    logger.exception("ditto-pipecat: VIDEO WRITER DIED")
                    return
            deadline += self._period
            rest = deadline - _time.perf_counter()
            if rest > 0:
                _time.sleep(rest)
            elif rest < -1.0:
                deadline = _time.perf_counter()

    async def _metronome(self):
        import time as _time

        deadline = _time.monotonic()
        try:
            while True:
                if self._latest is not None:
                    img, size, fmt = self._latest
                    # a FRESH frame object every tick — pipecat frames carry
                    # identity, and re-pushing one instance delivers exactly
                    # one image downstream (the one-keyframe-then-black bug)
                    await self.push_frame(OutputImageRawFrame(image=img, size=size, format=fmt))
                deadline += self._period
                delay = deadline - _time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    deadline = _time.monotonic()
        except asyncio.CancelledError:
            pass
