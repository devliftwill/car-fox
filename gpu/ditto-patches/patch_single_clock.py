"""One clock for video, not two.

The audio writer thread ticks every 40ms and sets pacer._latest; the pacer's
own writer thread ticks every 40ms and samples _latest. Two free-running
metronomes with no phase relationship: when the pacer samples early it writes
the previous frame AGAIN, when it samples late a generated frame is never
displayed at all. Average stays 25fps, motion advances 40/40/80/0ms -- judder.

Neither the session recording nor the acceptance gate can see this: the
recording is written from the audio clock (upstream of the beat) and the gate
counts arrivals, not distinctness.

FOX_SINGLE_CLOCK=1 (default): the audio writer -- already the master A/V clock
-- writes the frame to the camera device itself, at the same instant it writes
that tick's audio. The pacer thread keeps the sink resolved and only covers
gaps so the encoder never starves. FOX_SINGLE_CLOCK=0 keeps the old two-clock
path so the beat can be measured.
"""
import sys

p = "/home/will/fox-pipecat/ditto_video_service.py"
s = open(p).read()
if "carfox: single-clock" in s:
    print("already patched")
    sys.exit(0)

# --- counters ---------------------------------------------------------------
old_c = '''    "frames_published": 0, "playout_underruns": 0, "interruptions": 0,'''
new_c = '''    "frames_published": 0, "playout_underruns": 0, "interruptions": 0,
    # video clock health: a dup means the camera device was handed the same
    # frame twice, a skip means a generated frame was never displayed.
    "video_writes": 0, "video_dup_writes": 0, "video_skipped_frames": 0,
    "video_keepalive_writes": 0,'''
assert s.count(old_c) == 1, f"counters {s.count(old_c)}"
s = s.replace(old_c, new_c, 1)

# --- pacer state ------------------------------------------------------------
old_i = """        self._sink_getter = sink_getter
        self._writer_stop = False"""
new_i = """        self._sink_getter = sink_getter
        self._writer_stop = False
        # carfox: single-clock video. _seq advances every time the audio clock
        # publishes a frame; _written_seq is what the device has actually seen.
        self._seq = 0
        self._written_seq = -1
        self._sink_ref = None
        self._direct = os.environ.get("FOX_SINGLE_CLOCK", "1") == "1"
        self._last_direct = 0.0

    def set_latest(self, fb):
        \"\"\"Publish one 40ms tick's frame. Called from the audio writer thread,
        which is the master A/V clock -- in single-clock mode the write happens
        HERE, alongside that tick's audio, so every generated frame is shown
        exactly once.\"\"\"
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
            logger.exception("ditto-pipecat: direct video write failed")"""
assert s.count(old_i) == 1, f"init {s.count(old_i)}"
s = s.replace(old_i, new_i, 1)

# --- writer thread ----------------------------------------------------------
old_w = """                logger.info(f"ditto-pipecat: video sink resolved: {type(sink).__name__}")
            if self._latest is not None:
                img, _size, _fmt = self._latest
                try:
                    sink.write_frame(img)
                    self._writes = getattr(self, "_writes", 0) + 1
                    if self._writes % 250 == 1:
                        logger.info(f"ditto-pipecat: video device writes {self._writes}")
                except Exception:
                    logger.exception("ditto-pipecat: VIDEO WRITER DIED")
                    return"""
new_w = """                logger.info(f"ditto-pipecat: video sink resolved: {type(sink).__name__}")
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
                    return"""
assert s.count(old_w) == 1, f"writer {s.count(old_w)}"
s = s.replace(old_w, new_w, 1)

open(p, "w").write(s)
print("PATCHED ditto_video_service: single-clock video + clock-health counters")

# --- bot: route the setter through the pacer method --------------------------
b = "/home/will/fox-pipecat/fox_pipecat_bot.py"
t = open(b).read()
old_b = """            _current["ditto"]._frame_setter = (
                lambda fb, _p=pacer: setattr(_p, "_latest", (fb, (512, 512), "RGB"))
            )"""
new_b = """            _current["ditto"]._frame_setter = pacer.set_latest"""
if t.count(old_b) == 1:
    open(b, "w").write(t.replace(old_b, new_b, 1))
    print("PATCHED fox_pipecat_bot: frame setter -> pacer.set_latest")
else:
    print(f"bot anchor count {t.count(old_b)} -- CHECK MANUALLY")
