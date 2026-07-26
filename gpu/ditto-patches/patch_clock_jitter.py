"""Measure the master clock's cadence, and stop doing avoidable work on it.

Single-clock video means the audio writer thread now writes the audio slice,
writes the video frame, AND (with recording on, which is the production
default) JPEG-encodes a 512x512 frame -- all inside one 40ms tick. Anything
that slips there is jitter the viewer sees directly.

1. tick_jitter_ms_p95 / _max: how far actual tick spacing strays from 40ms.
2. The recording's JPEG encode moves to a background thread fed by a bounded
   queue, so troubleshooting capture costs the clock a queue append.
"""
import sys

p = "/home/will/fox-pipecat/ditto_video_service.py"
s = open(p).read()
if "carfox: clock jitter" in s:
    print("already patched")
    sys.exit(0)

# --- counters ---------------------------------------------------------------
old_c = '''    "video_keepalive_writes": 0,'''
new_c = '''    "video_keepalive_writes": 0,
    # master-clock health: tick spacing should sit at 40ms.
    "tick_jitter_ms_p95": 0.0, "tick_jitter_ms_max": 0.0, "rec_frames_dropped": 0,'''
assert s.count(old_c) == 1, f"counters {s.count(old_c)}"
s = s.replace(old_c, new_c, 1)

# --- background JPEG encoder -------------------------------------------------
old_r = """                # Rolling ring for the whole session (JPEG so 90s fits in RAM).
                if self._rec_ring is not None:
                    jpg = None
                    if fb_now is not None:
                        try:
                            arr = np.frombuffer(fb_now, dtype=np.uint8).reshape(512, 512, 3)
                            ok, enc = cv2.imencode(
                                ".jpg", arr[:, :, ::-1],
                                [int(cv2.IMWRITE_JPEG_QUALITY), int(os.environ.get("FOX_RECORD_Q", "55"))],
                            )
                            jpg = enc.tobytes() if ok else None
                        except Exception:
                            jpg = None
                    with self._rec_lock:
                        self._rec_ring.append((piece, jpg))"""
new_r = """                # Rolling ring for the whole session. carfox: the JPEG encode
                # runs on a BACKGROUND thread -- doing it here spent several ms
                # of every 40ms tick on the clock that paces both media tracks.
                if self._rec_ring is not None:
                    try:
                        self._rec_q.put_nowait((piece, fb_now))
                    except queue.Full:
                        COUNTERS["rec_frames_dropped"] += 1"""
assert s.count(old_r) == 1, f"recording {s.count(old_r)}"
s = s.replace(old_r, new_r, 1)

# --- jitter measurement + encoder startup ------------------------------------
old_j = """        deadline = _time.perf_counter()
        sink = None
        while not self._stopping:
            if sink is None:
                sink = self._audio_sink_getter() if self._audio_sink_getter else None"""
new_j = """        deadline = _time.perf_counter()
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
                sink = self._audio_sink_getter() if self._audio_sink_getter else None"""
assert s.count(old_j) == 1, f"jitter {s.count(old_j)}"
s = s.replace(old_j, new_j, 1)

# --- the encoder thread ------------------------------------------------------
old_d = """    def dump_session_recording(self, path):"""
new_d = '''    def _rec_encoder_thread(self):
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

    def dump_session_recording(self, path):'''
assert s.count(old_d) == 1, f"dump {s.count(old_d)}"
s = s.replace(old_d, new_d, 1)

open(p, "w").write(s)
print("PATCHED: clock jitter counters + background JPEG encoder")
