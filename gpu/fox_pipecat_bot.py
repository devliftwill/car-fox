"""carfox Pipecat bot — the LemonSlice-architecture character call.

FastAPI on :8012 (reached via the :8010 /pipecat proxy). Two transports:
  POST /api/daily/start  -> DailyTransport (production; LemonSlice's stack)
  POST /api/offer        -> SmallWebRTC (fallback when no DAILY_API_KEY)
Each call builds: mic in -> Gemini Live (voice loop) -> DittoVideoService -> out.
Single active session (the A100 runs one avatar pipeline at a time).
"""

import asyncio
import json
import os
import sys
import time

import aiohttp
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipecat.frames.frames import InputAudioRawFrame, LLMRunFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService, GeminiVADParams, InputParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

try:  # pipecat >= 0.0.100 layout, with legacy fallback
    from pipecat.transports.daily.transport import DailyParams, DailyTransport
except ImportError:  # pragma: no cover
    from pipecat.transports.services.daily import DailyParams, DailyTransport

from ditto_video_service import DittoVideoService, FramePacer, get_sdk, trace_snapshot
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

DAILY_API_KEY = os.environ.get("DAILY_API_KEY", "")
DAILY_API = "https://api.daily.co/v1"

AVATAR_DIR = os.path.expanduser("~/LiveTalking/data/avatars")
FOX_PROMPT = (
    "You are the CAR FOX — a sharp, upbeat fox mascot who helps people avoid "
    "buying bad used cars. Keep replies SHORT (one to three sentences), "
    "energetic, and conversational. Never mention being an AI."
)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_current: dict = {"task": None, "runner_task": None}


def _resolve_source(avatar_id: str):
    """Where this character's likeness comes from.

    A VIDEO source wins over a still when both exist: Ditto animates the face
    on each source frame and its LoopLoader mirror-loops the clip, so the body
    keeps breathing/shifting between utterances instead of being a frozen
    photo. Measured 2026-07-26 on a 75-frame clip: 25.0 fps and pipeline fill
    40-41 frames — identical to a still, so the motion is free.
    """
    if "/" in avatar_id or ".." in avatar_id:
        return None
    for name in ("source.mp4", "source.webm", "source.png", "source.jpg"):
        p = os.path.join(AVATAR_DIR, avatar_id, name)
        if os.path.exists(p):
            return p
    return None


async def _teardown_current():
    # single-session: cancel whatever is running and WAIT for it to fully
    # unwind before building the next pipeline (a second session built while
    # the first was mid-teardown never produced frames)
    if _current["task"] is not None:
        try:
            await _current["task"].cancel()
        except Exception:
            pass
        _current["task"] = None
    if _current.get("runner_task") is not None:
        try:
            await asyncio.wait_for(_current["runner_task"], timeout=10)
        except Exception:
            pass
        _current["runner_task"] = None
    # daily-python: the previous CallClient MUST be released or the next
    # session's camera track never transmits (first-call-works,
    # second-call-black in the same process)
    tr = _current.pop("transport", None)
    if tr is not None:
        try:
            raw = getattr(getattr(tr, "_client", None), "_client", None)
            if raw is not None:
                await asyncio.get_running_loop().run_in_executor(None, raw.release)
                logger.info("teardown: previous daily client released")
        except Exception as e:
            logger.warning(f"teardown: client release: {e}")



class _TestBars(FrameProcessor):
    """FOX_TEST_BARS=1 diagnostic: replaces the fox engine with moving color
    bars so pipeline-vs-engine faults separate cleanly."""

    def __init__(self):
        super().__init__()
        self._task = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        from pipecat.frames.frames import StartFrame
        if isinstance(frame, StartFrame) and self._task is None:
            self._task = asyncio.create_task(self._generate())

    async def _generate(self):
        import time as _t
        import numpy as _np
        from pipecat.frames.frames import OutputImageRawFrame
        i = 0
        base = _np.zeros((512, 512, 3), dtype=_np.uint8)
        deadline = _t.monotonic()
        while True:
            img = base.copy()
            x = (i * 7) % 512
            img[:, :, 0] = 40
            img[:, x : min(512, x + 60), 1] = 255
            await self.push_frame(
                OutputImageRawFrame(image=_np.ascontiguousarray(img).tobytes(), size=(512, 512), format="RGB")
            )
            i += 1
            deadline += 0.04
            d = deadline - _t.monotonic()
            if d > 0:
                await asyncio.sleep(d)
            else:
                deadline = _t.monotonic()



class _EarLevel(FrameProcessor):
    """Proves the fox can HEAR whoever he is talking to.

    Passive: every inbound audio frame's RMS is folded into a rolling figure
    that /health reports, and the frame is passed straight through.

    This exists because "deaf" and "listening to a silent room" look
    identical from outside the box. A meeting bot that never answers a
    question could be failing at the mic, the transport, Gemini, or the
    speaker, and without a number here the only way to tell them apart was
    to ask a human to talk to it and see. That guesswork cost most of a day.
    """

    def __init__(self):
        super().__init__()
        _current["ear"] = {"frames": 0, "rms": 0.0, "peak": 0.0, "voiced": 0, "last_s": 0.0}

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and frame.audio:
            try:
                import numpy as _np

                pcm = _np.frombuffer(frame.audio, dtype=_np.int16).astype(_np.float32)
                if pcm.size:
                    rms = float(_np.sqrt((pcm * pcm).mean())) / 32768.0
                    ear = _current.setdefault(
                        "ear", {"frames": 0, "rms": 0.0, "peak": 0.0, "voiced": 0, "last_s": 0.0}
                    )
                    ear["frames"] += 1
                    ear["rms"] = round(0.9 * ear["rms"] + 0.1 * rms, 5)
                    ear["peak"] = round(max(ear["peak"], rms), 5)
                    # -46 dBFS: comfortably above line noise, below speech
                    if rms > 0.005:
                        ear["voiced"] += 1
                    ear["last_s"] = round(time.time(), 1)
                    if ear["frames"] % 250 == 1:
                        logger.info(
                            f"carfox-ear: frames={ear['frames']} rms={ear['rms']} "
                            f"peak={ear['peak']} voiced={ear['voiced']}"
                        )
            except Exception:
                pass  # a metering fault must never break the voice path
        await self.push_frame(frame, direction)


class _DropAudio(FrameProcessor):
    """FOX_TEST_BARS=3 diagnostic: discards downstream audio so the
    transport sees ditto's video cadence but none of its audio."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        from pipecat.frames.frames import TTSAudioRawFrame
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TTSAudioRawFrame):
            return
        await self.push_frame(frame, direction)


def _build_pipeline(transport, source: str, idle_timeout: float = 300.0):
    llm = GeminiLiveLLMService(
        api_key=os.environ["GEMINI_API_KEY"],
        # swappable so audio quality can be A/B'd. gemini-3.1-flash-live-preview
        # is the low-latency dialogue model; the 2.5 native-audio preview is
        # documented as tuned for higher-quality, more natural audio output.
        model=os.environ.get("FOX_GEMINI_MODEL", "models/gemini-3.1-flash-live-preview"),
        voice_id="Puck",
        system_instruction=FOX_PROMPT,
        # reply reliability + snappier turns: trigger on quieter speech,
        # close the user's turn fast (this was the ~5s of the 13s reply lag)
        # START sensitivity HIGH made the fox interrupt itself: speakers bleed
        # into the mic, Gemini hears "user talking" and truncates mid-sentence
        # (reported as "the last thing the fox said got cut off"). LOW keeps
        # deliberate interruptions working without echo triggering them.
        # END sensitivity stays HIGH + a short silence window so turns close fast.
        params=InputParams(vad=GeminiVADParams(
            # Only HIGH/LOW are valid here -- "MEDIUM" made Gemini reject the
            # whole session (1007 Invalid value ... start_of_speech_sensitivity)
            # and the fox went silent. Validate rather than trust the env.
            start_sensitivity=(
                os.environ.get("FOX_VAD_START", "START_SENSITIVITY_LOW")
                if os.environ.get("FOX_VAD_START", "START_SENSITIVITY_LOW")
                in ("START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW")
                else "START_SENSITIVITY_LOW"
            ),
            end_sensitivity="END_SENSITIVITY_HIGH",
            silence_duration_ms=int(os.environ.get("FOX_VAD_SILENCE_MS", "300")),
        )),
    )

    ditto = None if os.environ.get("FOX_TEST_BARS") in ("1", "2") else DittoVideoService(source_path=source)  # mode 3 keeps ditto
    _current["ditto"] = ditto

    # Canonical shape from pipecat's official realtime Gemini example:
    # NO local VAD anywhere (server-side VAD handles turns), passive
    # context aggregators around the llm.
    context = LLMContext(
        [{"role": "developer", "content": "Greet me in one short energetic sentence and ask what kind of car I'm hunting for."}]
    )
    user_agg, assistant_agg = LLMContextAggregatorPair(context)

    test_mode = os.environ.get("FOX_TEST_BARS")
    if test_mode == "1":
        video_chain = [_TestBars()]
    elif test_mode == "2":  # pacer alone: static photo on the metronome
        video_chain = [FramePacer(fps=25, initial_image_path=source)]
    elif test_mode == "3":  # ditto runs, but its audio is discarded
        video_chain = [ditto, _DropAudio(), FramePacer(fps=25, initial_image_path=source)]
    else:
        pacer = FramePacer(fps=25, initial_image_path=source)
        _current["pacer"] = pacer
        video_chain = [ditto, pacer]
    pipeline = Pipeline([
        transport.input(),
        _EarLevel(),
        user_agg,
        llm,
        *video_chain,
        transport.output(),
        assistant_agg,
    ])
    # Pipecat cancels a pipeline after idle_timeout_secs with no speech either
    # way — 300s by default. That is reasonable for a website visitor who
    # wandered off, and WRONG for a meeting, where sitting quietly and
    # listening is the normal state. It killed a live call at exactly the
    # five minute mark and left the bot on screen showing a black frame.
    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True),
        idle_timeout_secs=idle_timeout,
    )
    _current["task"] = task

    async def send_greeting():
        if _current.get("greeted"):
            return
        _current["greeted"] = True
        # wait for the face engine — a greeting spoken over a frozen photo
        # reads as broken; lips must be able to move with the first word
        d = _current.get("ditto")
        for _ in range(40):
            if d is None or getattr(d, "_primed", False):
                break
            await asyncio.sleep(0.5)
        logger.info("pipecat: sending greeting (client can hear, engine primed)")
        await task.queue_frames([LLMRunFrame()])
        await asyncio.sleep(3)
        llm.set_audio_input_paused(False)
        logger.info("pipecat: audio input unpaused — conversational")

    _current["greet"] = send_greeting
    _current["greeted"] = False

    def arm_greet_fallback(delay: float = 25.0):
        async def greet_fallback():
            await asyncio.sleep(delay)
            await send_greeting()  # never leave a silent fox forever

        asyncio.create_task(greet_fallback())

    return task, arm_greet_fallback


async def _daily_post(session: aiohttp.ClientSession, path: str, payload: dict):
    async with session.post(
        f"{DAILY_API}{path}",
        headers={"Authorization": f"Bearer {DAILY_API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=aiohttp.ClientTimeout(total=15),
    ) as r:
        data = await r.json()
        if r.status >= 300:
            raise RuntimeError(f"daily {path} -> {r.status}: {data}")
        return data


@app.post("/api/daily/check")
async def daily_check(body: dict = None):
    return {"configured": bool(DAILY_API_KEY)}


@app.post("/api/daily/start")
async def daily_start(body: dict):
    """Create a Daily room + tokens, run the bot into it, hand the client its seat."""
    if not DAILY_API_KEY:
        return {"error": "daily_not_configured"}
    avatar_id = body.get("avatar_id", "fox_ditto")
    source = _resolve_source(avatar_id)
    if source is None:
        return {"error": f"unknown character avatar {avatar_id}"}

    # A100 = ONE avatar pipeline (measured: a second concurrent session halves
    # both). Normally a new caller evicts the old one, which is fine for two
    # people trying the website. It is NOT fine mid-meeting: anyone who opened
    # car-fox.vercel.app would silently kill the fox in front of a room of
    # people. A held session refuses newcomers instead of yielding to them.
    # The hold belongs to ONE caller, identified by hold_id. A bare boolean was
    # not enough: two meeting bots in the same call both asked to hold, both
    # were granted it, and each tore down the other's session on arrival — the
    # fox rendered, never finished waking, and answered nobody.
    hold = bool(body.get("hold"))
    hold_id = body.get("hold_id") or ""
    held = _current.get("hold_until", 0) > time.time()
    if held and hold_id != _current.get("hold_id"):
        logger.info("pipecat[daily]: refusing start — another session holds this box")
        return {"error": "busy"}
    if hold:
        _current["hold_until"] = time.time() + 180
        _current["hold_id"] = hold_id

    await _teardown_current()

    exp = int(time.time()) + 3600
    async with aiohttp.ClientSession() as session:
        room = await _daily_post(session, "/rooms", {
            "privacy": "private",
            "properties": {
                "exp": exp,
                "max_participants": 2,
                "eject_at_room_exp": True,
                "enable_chat": False,
                "start_video_off": True,
                # stay on the SFU — the P2P switchover ~7s into a 2-person
                # room kills daily-python's outbound tracks (video 0bps)
                "sfu_switchover": 0.5,
            },
        })
        room_url = room["url"]
        room_name = room["name"]
        bot_token = (await _daily_post(session, "/meeting-tokens", {
            "properties": {"room_name": room_name, "is_owner": True, "user_name": "CAR FOX", "exp": exp},
        }))["token"]
        user_token = (await _daily_post(session, "/meeting-tokens", {
            "properties": {"room_name": room_name, "user_name": "driver", "exp": exp},
        }))["token"]

    transport = DailyTransport(
        room_url,
        bot_token,
        "CAR FOX",
        DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            # play Gemini's native rate; the 16k downsample is only for lips
            audio_out_sample_rate=int(os.environ.get("FOX_PLAY_SR", "24000")),
            video_out_enabled=True,
            # NOT video_out_is_live: the non-live path redraws the newest
            # frame on the transport's own fixed 25fps clock, which is the
            # exact write pattern the bare daily-python probe proved out
            # (is_live mode produced 0 video bps through Daily's encoder)
            video_out_width=512,
            video_out_height=512,
            video_out_framerate=25,
        ),
    )

    _current["transport"] = transport
    # A meeting bot may legitimately listen in silence for a long stretch;
    # a website visitor who has said nothing for five minutes has left. The
    # session still ends the moment the far side leaves the room, so the
    # longer ceiling costs nothing in the normal case — it is only a backstop
    # against a page that dies without disconnecting cleanly.
    task, arm_greet_fallback = _build_pipeline(
        transport, source, idle_timeout=2700.0 if hold else 300.0
    )

    # Daily path: BOTH media tracks are written from plain threads, exactly
    # like the bare daily-python probe that streams perfectly — pipecat
    # handles signaling/mic-in/Gemini, the devices get direct writes.
    if _current.get("ditto") is not None:
        _current["ditto"].set_audio_sink_getter(
            lambda: getattr(getattr(transport._client, "_microphone_track", None), "source", None)
        )
    if _current.get("pacer") is not None:
        pacer = _current["pacer"]
        pacer._sink_getter = (
            lambda: getattr(getattr(transport._client, "_camera_track", None), "source", None)
        )
        if _current.get("ditto") is not None:
            # the audio writer publishes each 40ms tick's frame here —
            # lips follow the voice at playback time
            _current["ditto"]._frame_setter = pacer.set_latest

    # write-path probe: does the pipeline still hand frames to daily-python
    # while the client sees 0 video bps?
    client = getattr(transport, "_client", None)
    if client is not None and hasattr(client, "write_video_frame"):
        orig_wvf = client.write_video_frame
        orig_waf = getattr(client, "write_audio_frame", None)

        async def counting_wvf(frame, _o=orig_wvf):
            n = _current["vw"] = _current.get("vw", 0) + 1
            if n % 100 == 1:
                logger.info(f"carfox-probe: video writes {n}")
            return await _o(frame)

        client.write_video_frame = counting_wvf
        if orig_waf is not None:
            async def counting_waf(frame, _o=orig_waf):
                n = _current["aw"] = _current.get("aw", 0) + 1
                if n % 100 == 1:
                    logger.info(f"carfox-probe: audio writes {n}")
                return await _o(frame)

            client.write_audio_frame = counting_waf

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(t, participant):
        logger.info("pipecat[daily]: participant joined — waiting for audible-playback confirmation")
        arm_greet_fallback(25)

    @transport.event_handler("on_participant_left")
    async def on_participant_left(t, participant, reason=None):
        # COST: when the visitor leaves, end the pipeline. Without this the
        # session stayed "active" forever, /health never reported idle, the
        # auto-stop timer never fired and the A100 billed indefinitely
        # ($3.67/hr) after a single demo call.
        others = [p for p in (t.participants() or {}).items() if p[0] != "local"]
        if others:
            return
        logger.info("pipecat[daily]: visitor left — ending session so the box can idle out")
        try:
            await task.cancel()
        except Exception:
            pass

    runner = PipelineRunner(handle_sigint=False)
    rt = asyncio.create_task(runner.run(task))
    _current["runner_task"] = rt

    def _dump_session():
        # Persist this call's trace. The in-memory ring dies when the box sleeps,
        # and the sessions actually worth diagnosing are the visitor's, not the
        # ones I run myself.
        try:
            stamp = int(time.time())
            snap = trace_snapshot(4000)
            path = f"/var/tmp/fox-session-{stamp}.json"
            with open(path, "w") as fh:
                json.dump(snap, fh)
            # the media itself, so "the mouth was off" can be watched back
            svc = _current.get("ditto")
            if svc is not None:
                try:
                    svc.dump_session_recording(f"/var/tmp/fox-session-{stamp}.mp4")
                except Exception as e:
                    logger.warning(f"recording dump failed: {e}")
            c = snap["counters"]
            logger.info(
                f"SESSION SUMMARY -> {path} | interruptions={c['interruptions']} "
                f"pair_drift={c['pair_drift']} speech_dropped={c['speech_audio_dropped']} "
                f"underruns={c['playout_underruns']} windows_fed={c['windows_fed']}"
            )
        except Exception as e:
            logger.warning(f"session dump failed: {e}")

    def _session_done(_t):
        # the pipeline has fully unwound: report idle so the idle-check can
        # power the machine down.
        if _current.get("task") is task:
            _current["task"] = None
            # the meeting is over; the box is free for the next caller
            _current["hold_until"] = 0
            _current["hold_id"] = ""
            logger.info("pipecat[daily]: session finished — now idle")
            _dump_session()

    rt.add_done_callback(_session_done)

    return {"room_url": room_url, "token": user_token, "expires": exp}


@app.post("/api/offer")
async def offer(body: dict):
    avatar_id = body.get("avatar_id", "fox_ditto")
    source = _resolve_source(avatar_id)
    if source is None:
        return {"error": f"unknown character avatar {avatar_id}"}

    await _teardown_current()

    connection = SmallWebRTCConnection(ice_servers=["stun:stun.l.google.com:19302"])
    await connection.initialize(sdp=body["sdp"], type=body["type"])

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_sample_rate=16000,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=512,
            video_out_height=512,
            video_out_framerate=25,
        ),
    )

    task, arm_greet_fallback = _build_pipeline(transport, source)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(t, client):
        logger.info("pipecat: client connected — waiting for audible-playback confirmation")
        arm_greet_fallback(25)

    runner = PipelineRunner(handle_sigint=False)
    _current["runner_task"] = asyncio.create_task(runner.run(task))

    answer = connection.get_answer()
    return answer


@app.post("/api/avatar/video")
async def upload_avatar_video(
    avatar_id: str = Form(...),
    video: UploadFile = File(...),
):
    """Record-a-clip characters: the uploaded video BECOMES the source.

    No generation step and no training — Ditto reads source frames directly
    (core/atomic_components/loader.py load_source_frames branches on
    image-vs-video) and its LoopLoader mirror-loops them, so a few seconds of
    someone breathing and shifting gives the character continuous body motion
    between utterances. Measured: a 75-frame clip sustains 25.0 fps with the
    same 40-41 frame pipeline fill as a still, so the movement is free.

    Keep clips SHORT (2-5s). Every source frame is registered at setup, so a
    long clip only slows startup; the mirror loop makes 3s look continuous.
    """
    if "/" in avatar_id or ".." in avatar_id or not avatar_id:
        return {"error": "bad avatar_id"}
    name = (video.filename or "").lower()
    ext = ".webm" if name.endswith(".webm") else ".mp4"
    d = os.path.join(AVATAR_DIR, avatar_id)
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, f"source{ext}")
    data = await video.read()
    if not data:
        return {"error": "empty upload"}
    with open(dest, "wb") as fh:
        fh.write(data)
    # Poster frame. The thumbnail endpoint serves source.png, so without this
    # a video avatar shows a broken image in the picker. _resolve_source still
    # prefers the video (it is first in the list), so this is display only.
    poster = os.path.join(d, "source.png")
    try:
        import subprocess

        # Seek ~1s in, not frame 0: a webcam's first frames are black while
        # auto-exposure settles, which produced a black thumbnail. Fall back
        # to the very start for clips shorter than the seek.
        for seek in ("00:00:01.0", "00:00:00.3", "00:00:00.0"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", seek, "-i", dest,
                 "-vframes", "1", poster],
                check=False, capture_output=True, timeout=60,
            )
            if os.path.exists(poster) and os.path.getsize(poster) > 2000:
                break
    except Exception as e:
        logger.warning(f"avatar {avatar_id}: poster frame failed: {e}")
    logger.info(f"avatar {avatar_id}: video source saved ({len(data)} bytes) -> {dest}")
    return {"ok": True, "avatar_id": avatar_id, "source": os.path.basename(dest),
            "bytes": len(data), "poster": os.path.exists(poster)}


@app.post("/api/avatar/remove")
async def delete_avatar(avatar_id: str = Form(...)):
    """Remove a character from the demo library.

    POST, not DELETE: the :8010 proxy that fronts this service rejects DELETE
    with a 405 (verified), while POST is already proven by the video upload.

    Demo-surface only: the built-in fox is protected so the library can never
    be emptied to the point where there is nothing to call.
    """
    if "/" in avatar_id or ".." in avatar_id or not avatar_id:
        return {"error": "bad avatar_id"}
    if avatar_id == "fox_ditto":
        return {"error": "the built-in Car Fox cannot be removed"}
    d = os.path.join(AVATAR_DIR, avatar_id)
    if not os.path.isdir(d):
        return {"error": "not found"}
    import shutil

    shutil.rmtree(d, ignore_errors=True)
    logger.info(f"avatar {avatar_id}: removed")
    return {"ok": True, "avatar_id": avatar_id}


@app.post("/api/telemetry")
async def telemetry(body: dict):
    """Client-side ground truth lands in our logs (audibility, fps, play state)."""
    logger.info(f"carfox-telemetry: {body}")
    if body.get("event") in ("play_ok", "unmute_ok") and _current.get("greet"):
        await _current["greet"]()
    return {"ok": True}


@app.post("/api/keepalive")
async def keepalive(body: dict = None):
    """Touch the keep-awake lock: while a visitor has the demo page open the
    box must not power itself off between calls (that cost them a ~2 minute
    wake). The lock is only honoured for 3 minutes, so closing the page lets
    the machine sleep again and the cost saving is preserved."""
    try:
        with open("/var/tmp/fox-keep-awake", "w") as f:
            f.write(str(time.time()))
        # a meeting bot renews its claim on the box with every ping, so the
        # hold dies ~3 minutes after the bot leaves the call
        b = body or {}
        # only the holder may renew its own claim
        if b.get("hold") and b.get("hold_id", "") == _current.get("hold_id", ""):
            _current["hold_until"] = time.time() + 180
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}


@app.get("/api/recordings")
async def list_recordings():
    """Recent session artefacts: an mp4 of exactly what the visitor received
    and the matching per-window trace."""
    import glob

    out = []
    for f in sorted(glob.glob("/var/tmp/fox-session-*"), reverse=True)[:40]:
        try:
            out.append({"file": os.path.basename(f), "bytes": os.path.getsize(f)})
        except OSError:
            pass
    return {"recordings": out}


@app.get("/api/recording/{name}")
async def get_recording(name: str):
    """Download one artefact. Name-only, no paths — this is a debug surface."""
    from fastapi.responses import FileResponse

    if "/" in name or ".." in name or not name.startswith("fox-session-"):
        return {"error": "bad name"}
    path = os.path.join("/var/tmp", name)
    if not os.path.exists(path):
        return {"error": "not found"}
    return FileResponse(path)


@app.get("/api/trace")
async def get_trace(limit: int = 400):
    """Per-window pipeline trace + counters for the last minutes of calls.

    Answers, with timestamps rather than guesses:
      * where a reply's delay went (Gemini thinking vs engine vs playout)
      * whether audio and frames stayed paired  (counters.pair_drift must be 0)
      * whether the fox is being interrupted    (counters.interruptions)
      * whether playout is starving             (counters.playout_underruns)
    """
    return trace_snapshot(limit)


@app.get("/api/turns")
async def get_turns():
    """Delay attribution per turn, derived from the trace.

    user_started_speaking -> gemini_audio_first  = Gemini listening + thinking
    gemini_audio_first    -> fed_speech_start    = our intake
    fed_speech_start      -> emit_speech_start   = the face engine
    emit_speech_start     -> play_speech_start   = playout buffering
    """
    snap = trace_snapshot(4000)
    evs = snap["events"]
    turns, cur = [], None
    for e in evs:
        ev, t = e["ev"], e["t"]
        if ev == "user_started_speaking":
            if cur:
                turns.append(cur)
            cur = {"user_start": t}
        elif cur is None:
            continue
        elif ev == "gemini_audio_first" and "gemini" not in cur:
            cur["gemini"] = t
        elif ev == "fed_speech_start" and "fed" not in cur:
            cur["fed"] = t
        elif ev == "emit_speech_start" and "emit" not in cur:
            cur["emit"] = t
        elif ev == "play_speech_start" and "play" not in cur:
            cur["play"] = t
    if cur:
        turns.append(cur)

    out = []
    for i, t in enumerate(turns[-12:]):
        row = {"turn": i + 1}
        def gap(a, b):
            return round(t[b] - t[a], 2) if a in t and b in t else None
        row["think_s"] = gap("user_start", "gemini")
        row["intake_s"] = gap("gemini", "fed")
        row["engine_s"] = gap("fed", "emit")
        row["playout_s"] = gap("emit", "play")
        row["total_s"] = gap("user_start", "play")
        out.append(row)
    return {"turns": out, "counters": snap["counters"]}


@app.get("/health")
async def health():
    held = _current.get("hold_until", 0)
    return {
        "ok": True,
        "active": _current.get("task") is not None,
        # held == a meeting bot owns this box; website visitors get "busy"
        # instead of evicting the call (see daily_start)
        "held": held > time.time(),
        # what the fox is hearing right now — the fastest way to tell a deaf
        # session from a quiet one without joining the call yourself
        "ear": _current.get("ear", {}),
    }


if __name__ == "__main__":
    get_sdk()  # preload models before accepting calls
    uvicorn.run(app, host="0.0.0.0", port=8012)
