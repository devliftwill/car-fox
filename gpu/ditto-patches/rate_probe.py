"""Measure the Ditto engine's SUSTAINED frame production rate.

Feeds 200ms windows at realtime (like the live feeder) and reports frames
produced per wall-second. If this is < 25 fps, the pipeline can never keep
up with realtime audio and latency grows without bound — which would make
it the root cause of every backlog problem, not the queueing.
"""
import os, sys, queue, threading, time
import numpy as np

DITTO_ROOT = os.path.expanduser("~/ditto-talkinghead")
sys.path.insert(0, DITTO_ROOT)
from stream_pipeline_online import StreamSDK

CHUNK = (3, 5, 2); WINDOW = 6400

class PSDK(StreamSDK):
    def bridge_reset(self):
        self.frame_out = queue.Queue(); self.frames_written = 0
    def _writer_worker(self):
        while not self.stop_event.is_set():
            try:
                item = self.writer_queue.get(timeout=1)
            except queue.Empty:
                continue
            if item is None:
                break
            self.frames_written += 1

steps = int(os.environ.get("DITTO_STEPS", "10"))
maxsize = int(os.environ.get("PROBE_MAXSIZE", "1024"))
sdk = PSDK(os.path.join(DITTO_ROOT, "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"),
           os.path.join(DITTO_ROOT, "checkpoints/ditto_pytorch"))
sdk.bridge_reset()
sdk.setup(os.path.expanduser("~/LiveTalking/data/avatars/fox_ditto/source.png"),
          "/tmp/unused.mp4", online_mode=True, sampling_timesteps=steps, max_size=maxsize,
          overlap_v2=int(os.environ.get("PROBE_OVERLAP","10")))
print(f"SETUP steps={steps} max_size={maxsize} overlap_v2={os.environ.get('PROBE_OVERLAP','10')}", flush=True)

dummy = np.zeros(WINDOW, dtype=np.float32)
t0 = time.perf_counter(); deadline = t0
fed = 0
marks = []
DUR = float(os.environ.get("PROBE_DUR","30"))
while time.perf_counter() - t0 < DUR:
    sdk.run_chunk(dummy, chunksize=CHUNK)
    fed += 1
    deadline += 0.2
    rest = deadline - time.perf_counter()
    if rest > 0:
        time.sleep(rest)
    el = time.perf_counter() - t0
    if fed % 25 == 0:
        marks.append((round(el,1), fed*5, sdk.frames_written))
        print(f"t={el:5.1f}s fed_frames={fed*5:4d} produced={sdk.frames_written:4d} "
              f"prod_fps={sdk.frames_written/el:5.1f} deficit={fed*5-sdk.frames_written:4d}", flush=True)

# let it settle: stop feeding, see how much more comes out
el0 = time.perf_counter(); n0 = sdk.frames_written
time.sleep(10)
print(f"after 12s idle: produced {sdk.frames_written} (+{sdk.frames_written-n0})", flush=True)
tot = time.perf_counter() - t0
print(f"TOTAL fed {fed*5} frames in {DUR:.0f}s realtime; produced {sdk.frames_written}", flush=True)
if len(marks) >= 3:
    (ta,_,pa) = marks[1]; (tb,_,pb) = marks[-1]
    print(f"STEADY-STATE PRODUCTION = {(pb-pa)/(tb-ta):.1f} fps (need 25.0)", flush=True)
print(f"OVERALL = {sdk.frames_written/tot:.1f} fps", flush=True)
