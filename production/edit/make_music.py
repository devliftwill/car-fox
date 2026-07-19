#!/usr/bin/env python3
"""Procedural underscore for CAR FOX 'SOMEBODY KNOWS' (NEPHEW make_music pattern).

Timeline (s):  0-6  driveway suspense pad
               6-12 the sense — pulse fades in, tightens
              12-20 the run — driving pulse + riser
              20-22 paw stop — hard drop to near silence
              22-28 held tension resolving into warmth
              28-36 warm resolution
              36-40 end-card sting + tail
Outputs score.wav (48 kHz stereo).
"""
import wave
from pathlib import Path

import numpy as np

SR = 48000
DUR = 40.0
t = np.arange(int(SR * DUR)) / SR
mix = np.zeros_like(t)


def env_between(a, b, fade=1.5):
    """Smooth 0->1->0 window between times a..b."""
    e = np.clip((t - a) / fade, 0, 1) * np.clip((b - t) / fade, 0, 1)
    return np.clip(e, 0, 1)


def tone(freq, amp, a, b, fade=1.5, detune=0.15, vib=0.0):
    f = freq * (1 + vib * np.sin(2 * np.pi * 0.4 * t))
    w = np.sin(2 * np.pi * f * t) + 0.6 * np.sin(2 * np.pi * (freq + detune) * t)
    return amp * env_between(a, b, fade) * w


# --- suspense pads: low D drone with minor color (0-22s) ---
mix += tone(73.42, 0.10, 0.0, 21.5)            # D2
mix += tone(110.0, 0.05, 0.0, 21.5)            # A2
mix += tone(146.83, 0.035, 2.0, 12.0, vib=0.002)  # D3, slight movement

# --- the-sense pulse: soft low thump, 92 BPM tightening to 118 (6-20s) ---
beat_times = []
bt = 6.0
while bt < 20.0:
    frac = (bt - 6.0) / 14.0
    beat_times.append(bt)
    bt += 60.0 / (92 + 26 * frac)
for b in beat_times:
    i = int(b * SR)
    n = int(0.14 * SR)
    if i + n < len(mix):
        seg = np.arange(n) / SR
        amp = 0.16 if b < 12 else 0.24
        thump = amp * np.exp(-30 * seg) * np.sin(2 * np.pi * 55 * seg)
        mix[i:i + n] += thump

# --- run layer: driving eighth-note saw pulse in D minor (12-20s) ---
run_env = env_between(12.0, 20.0, fade=0.8)
eighth = (np.floor(t * 4.72) % 2)  # ~141 BPM eighths feel
saw = 2 * ((t * 146.83) % 1) - 1
mix += 0.05 * run_env * eighth * saw

# --- riser into the stop (17.5-20s) ---
rng = np.random.default_rng(7)
noise = rng.standard_normal(len(t))
rise_env = np.clip((t - 17.5) / 2.5, 0, 1) ** 2 * (t < 20.0)
mix += 0.10 * rise_env * noise * np.sin(2 * np.pi * (400 + 900 * rise_env) * t)

# --- hard drop: duck everything 20.0-21.6s ---
duck = 1 - 0.92 * env_between(20.0, 21.6, fade=0.15)
mix *= duck

# --- lone held note through the question (20.2-27s) ---
mix += tone(220.0, 0.05, 20.2, 27.0, fade=1.0)  # A3, thin and exposed

# --- warm resolve: D major swell (27-36s) ---
for f, a in [(146.83, 0.09), (185.0, 0.07), (220.0, 0.07), (293.66, 0.05)]:
    mix += tone(f, a, 27.0, 36.5, fade=2.5)

# --- end-card sting: bright D major hit with slow decay (36.2s) ---
i = int(36.2 * SR)
n = int(3.5 * SR)
seg = np.arange(n) / SR
sting = np.zeros(n)
for f, a in [(293.66, 0.16), (369.99, 0.12), (440.0, 0.12), (587.33, 0.08)]:
    sting += a * np.exp(-1.1 * seg) * np.sin(2 * np.pi * f * seg)
mix[i:i + n] += sting[: len(mix) - i]

# gentle master shaping
mix = np.tanh(1.6 * mix) * 0.85
fade_out = np.clip((DUR - t) / 1.5, 0, 1)
mix *= fade_out

stereo = np.stack([mix, np.roll(mix, int(0.0007 * SR))], axis=1)
pcm = (np.clip(stereo, -1, 1) * 32767).astype(np.int16)

out = Path(__file__).resolve().parent.parent / "score.wav"
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"wrote {out}")
