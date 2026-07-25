"""Find the bottleneck stage: feed at realtime and watch every internal queue.

The stage whose INPUT queue backs up is the limiter. Also samples GPU
utilization so we can tell GPU-bound from CPU-bound.
"""
import os, sys, queue, subprocess, threading, time
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

sdk = PSDK(os.path.join(DITTO_ROOT, "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"),
           os.path.join(DITTO_ROOT, "checkpoints/ditto_pytorch"))
sdk.bridge_reset()
sdk.setup(os.path.expanduser("~/LiveTalking/data/avatars/fox_ditto/source.png"),
          "/tmp/unused.mp4", online_mode=True, sampling_timesteps=10, max_size=1024)
print("SETUP DONE", flush=True)

QUEUES = ["audio2motion_queue","motion_stitch_queue","warp_f3d_queue",
          "decode_f3d_queue","putback_queue","writer_queue"]

def gpu():
    try:
        out = subprocess.run(["nvidia-smi","--query-gpu=utilization.gpu,utilization.memory",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3)
        return out.stdout.strip().split("\n")[0]
    except Exception:
        return "?"

stop = False
def monitor():
    while not stop:
        depths = " ".join(f"{n.replace('_queue',''):>13}={getattr(sdk,n).qsize():3d}" for n in QUEUES)
        print(f"[{time.strftime('%H:%M:%S')}] gpu={gpu():>7}  produced={sdk.frames_written:4d}  {depths}", flush=True)
        time.sleep(3)
threading.Thread(target=monitor, daemon=True).start()

dummy = np.zeros(WINDOW, dtype=np.float32)
t0=time.perf_counter(); deadline=t0; fed=0
while time.perf_counter()-t0 < 30:
    sdk.run_chunk(dummy, chunksize=CHUNK); fed+=1
    deadline += 0.2
    r = deadline-time.perf_counter()
    if r>0: time.sleep(r)
stop=True
time.sleep(0.2)
el=time.perf_counter()-t0
print(f"FED {fed*5} frames in {el:.0f}s; PRODUCED {sdk.frames_written} => {sdk.frames_written/el:.1f} fps", flush=True)
