"""Offline engine sync test: feed a speech wav straight through the Ditto
SDK, collect ALL output frames in order, mux with the input audio at 25fps.
Isolates 'does the engine lip-sync correctly' from all live plumbing."""
import os, sys, queue, threading, wave, subprocess
import numpy as np

DITTO_ROOT = os.path.expanduser("~/ditto-talkinghead")
sys.path.insert(0, DITTO_ROOT)
from stream_pipeline_online import StreamSDK

CHUNK = (3, 5, 2); WINDOW = 6400; HOP = 3200

class PSDK(StreamSDK):
    def bridge_reset(self):
        self.frame_out = queue.Queue()
    def _writer_worker(self):
        while not self.stop_event.is_set():
            try:
                item = self.writer_queue.get(timeout=1)
            except queue.Empty:
                continue
            if item is None:
                break
            self.frame_out.put(item)

sdk = PSDK(
    os.path.join(DITTO_ROOT, "checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl"),
    os.path.join(DITTO_ROOT, "checkpoints/ditto_pytorch"),
)
sdk.bridge_reset()
sdk.setup(os.path.expanduser("~/LiveTalking/data/avatars/fox_ditto/source.png"),
          "/tmp/unused.mp4", online_mode=True, sampling_timesteps=10, max_size=1024)
print("SETUP DONE", flush=True)

# load speech
w = wave.open("/tmp/probe_speech.wav", "rb")
sr = w.getframerate(); n = w.getnframes()
raw = np.frombuffer(w.readframes(n), dtype=np.int16)
if w.getnchannels() == 2:
    raw = raw.reshape(-1, 2).mean(axis=1).astype(np.int16)
audio = raw.astype(np.float32) / 32768.0
if sr != 16000:
    import math
    idx = (np.arange(int(len(audio) * 16000 / sr)) * sr / 16000).astype(int)
    audio = audio[np.clip(idx, 0, len(audio) - 1)]
print(f"speech {len(audio)/16000:.1f}s", flush=True)

frames = []
def collect():
    while True:
        try:
            frames.append(sdk.frame_out.get(timeout=2))
        except queue.Empty:
            if getattr(collect, "done", False):
                return
threading.Thread(target=collect, daemon=True).start()

# feed windows (sliding, hop=200ms) — like the live feeder
buf = np.concatenate([audio, np.zeros(WINDOW, np.float32)])
i = 0
while i + WINDOW <= len(buf):
    sdk.run_chunk(buf[i:i+WINDOW].copy(), chunksize=CHUNK)
    i += HOP
import time as _t; _t.sleep(3)
collect.done = True
_t.sleep(1)
print(f"fed {i//HOP} windows -> {len(frames)} frames ({len(frames)/25:.1f}s of video)", flush=True)

# write raw video + audio, mux
with open("/tmp/probe_v.raw","wb") as f:
    for fr in frames:
        img = fr if fr.shape[2]==3 else fr[:,:,:3]
        if img.shape[:2]!=(512,512):
            import cv2; img=cv2.resize(img,(512,512))
        f.write(np.ascontiguousarray(img).tobytes())
with open("/tmp/probe_a.raw","wb") as f:
    f.write((audio*32767).astype(np.int16).tobytes())
subprocess.run(["ffmpeg","-y","-f","s16le","-ar","16000","-ac","1","-i","/tmp/probe_a.raw",
                "-f","rawvideo","-pix_fmt","rgb24","-s","512x512","-r","25","-i","/tmp/probe_v.raw",
                "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","/tmp/probe_out.mp4"],
               check=True, capture_output=True)
print("MUXED /tmp/probe_out.mp4", flush=True)
