"""Count duplicate frame CONTENT, not just duplicate writes.

`video_dup_writes` only increments on the two-clock path, so in the mode we
actually ship it is always 0 -- it proves the pacer beat is gone and nothing
else. If the engine emits two identical frames in a row they are each written
once, the counter stays 0, and the viewer still sees a stalled mouth.

The session recording cannot answer it either: it is JPEG q55 then x264, and
both will happily collapse a near-identical pair into an identical one (the
recording reads 14.7% duplicate during speech).

So CRC the raw 786KB frame bytes before any compression touches them, on the
recording's background thread so the master clock keeps its 40ms cadence.
"""
import sys

p = "/home/will/fox-pipecat/ditto_video_service.py"
s = open(p).read()
if "carfox: content dupes" in s:
    print("already patched")
    sys.exit(0)

old_c = '''    "tick_jitter_ms_p95": 0.0, "tick_jitter_ms_max": 0.0, "rec_frames_dropped": 0,'''
new_c = '''    "tick_jitter_ms_p95": 0.0, "tick_jitter_ms_max": 0.0, "rec_frames_dropped": 0,
    # distinctness of what was actually transmitted, measured on raw bytes
    # BEFORE the recording compresses anything.
    "frames_checked": 0, "frame_content_dupes": 0, "frame_dupes_in_speech": 0,'''
assert s.count(old_c) == 1, f"counters {s.count(old_c)}"
s = s.replace(old_c, new_c, 1)

old_e = """            jpg = None
            if fb is not None:
                try:"""
new_e = """            # carfox: content dupes -- CRC the raw frame before compression.
            if fb is not None:
                crc = zlib.crc32(fb)
                COUNTERS["frames_checked"] += 1
                if crc == getattr(self, "_last_crc", None):
                    COUNTERS["frame_content_dupes"] += 1
                    # loud audio on this tick == the mouth should be moving
                    try:
                        pk = np.abs(np.frombuffer(piece, dtype=np.int16)).max()
                    except Exception:
                        pk = 0
                    if pk > 900:
                        COUNTERS["frame_dupes_in_speech"] += 1
                self._last_crc = crc
            jpg = None
            if fb is not None:
                try:"""
assert s.count(old_e) == 1, f"encoder {s.count(old_e)}"
s = s.replace(old_e, new_e, 1)

if "\nimport zlib" not in s:
    s = s.replace("\nimport threading", "\nimport threading\nimport zlib", 1)

open(p, "w").write(s)
print("PATCHED: raw-frame content duplicate counters")
