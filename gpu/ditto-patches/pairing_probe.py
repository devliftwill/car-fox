"""Ground-truth probe for Ditto SDK frame accounting.

Questions this answers (previously guessed at, wrongly):
  1. Does every fed window yield EXACTLY 5 frames in steady state?
  2. How many frames does warmup consume/delay, and is it stable?
  3. What do arrival gaps look like (CUDA-compile stalls etc.)?
"""

import os
import queue
import sys
import threading
import time

import numpy as np

DITTO_ROOT = os.path.expanduser("~/ditto-talkinghead")
sys.path.insert(0, DITTO_ROOT)
from stream_pipeline_online import StreamSDK  # noqa: E402

CHUNK = (3, 5, 2)
WINDOW = 640 * sum(CHUNK)


class ProbeSDK(StreamSDK):
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
            self.frame_out.put(self.frames_written)
            self.frames_written += 1


sdk = ProbeSDK(
    os.path.join(DITTO_ROOT, "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"),
    os.path.join(DITTO_ROOT, "checkpoints/ditto_pytorch"),
)
sdk.bridge_reset()
sdk.setup(
    os.path.expanduser("~/LiveTalking/data/avatars/fox_ditto/source.png"),
    "/tmp/probe_unused.mp4",
    online_mode=True,
    sampling_timesteps=10,
    max_size=1024,
)
print("SETUP DONE", flush=True)

t0 = time.time()
arrivals = []


def watcher():
    while time.time() - t0 < 120:
        try:
            i = sdk.frame_out.get(timeout=0.5)
            arrivals.append((round(time.time() - t0, 2), i))
        except queue.Empty:
            pass


threading.Thread(target=watcher, daemon=True).start()

W = 25
dummy = np.zeros(WINDOW, dtype=np.float32)
feed_times = []
for k in range(W):
    ts = time.time()
    sdk.run_chunk(dummy, chunksize=CHUNK)
    feed_times.append((k, round(time.time() - t0, 2), round(time.time() - ts, 3)))
    time.sleep(0.12)
print("ALL FED:", feed_times[:3], "...", feed_times[-2:], flush=True)

# wait until output is quiet for 6s (or 90s hard cap)
last_n = len(arrivals)
last_t = time.time()
while time.time() - last_t < 6 and time.time() - t0 < 90:
    time.sleep(0.5)
    if len(arrivals) != last_n:
        last_n = len(arrivals)
        last_t = time.time()

print(f"FED {W} windows -> expected {W * 5} frames", flush=True)
print(f"GOT {len(arrivals)} frames (writer counter now {sdk.frames_written})", flush=True)
print("first 12 arrivals:", arrivals[:12], flush=True)
print("last 3 arrivals:", arrivals[-3:], flush=True)
gaps = [
    (arrivals[i][0], round(arrivals[i + 1][0] - arrivals[i][0], 2))
    for i in range(len(arrivals) - 1)
    if arrivals[i + 1][0] - arrivals[i][0] > 0.5
]
print("gaps>0.5s (at_time, gap):", gaps, flush=True)

# steady-state check: feed 10 more, expect exactly 50 more
base = sdk.frames_written
for k in range(10):
    sdk.run_chunk(dummy, chunksize=CHUNK)
    time.sleep(0.12)
last_n = len(arrivals)
last_t = time.time()
while time.time() - last_t < 6 and time.time() - t0 < 118:
    time.sleep(0.5)
    if len(arrivals) != last_n:
        last_n = len(arrivals)
        last_t = time.time()
print(f"STEADY: fed 10 more -> {sdk.frames_written - base} frames (expect 50)", flush=True)
print("PROBE COMPLETE", flush=True)
