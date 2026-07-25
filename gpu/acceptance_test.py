#!/usr/bin/env python
"""Headless end-to-end acceptance test for the self-hosted Car Fox.

Runs ON the GPU VM. Joins a real Daily call as a real participant, listens to
what the fox actually transmits, speaks a question into the room, and grades
the result against baselines. No browser, no human ears, repeatable.

    python acceptance_test.py                 # run + PASS/FAIL table
    python acceptance_test.py --json out.json # also dump raw metrics

Exit code is non-zero if any check fails, so it can gate a change.

Why this exists: every regression in this project (a frozen face that still
reported 25fps, a "cushion" that played pure silence, a warmup that buried the
greeting) looked fine in throughput logs and only showed up in the media. This
checks the media.
"""
import argparse
import json
import os
import sys
import threading
import time
import wave

import numpy as np
import requests

import daily

BOT = os.environ.get("FOX_BOT", "http://localhost:8012")
QUESTION_WAV = os.environ.get(
    "FOX_QUESTION_WAV", os.path.expanduser("~/fox-pipecat/test-question.wav")
)
AVATAR = os.environ.get("FOX_TEST_AVATAR", "fox_ditto")
SR = 16000                                    # our mic (question playback)
TICK = 320                                    # 20ms at 16k
# Capture at the fox's real playout rate so fidelity can be verified. If we
# captured at 16k we could not tell full-band 24k audio from a 16k downsample.
SPK_SR = int(os.environ.get("FOX_PLAY_SR", "24000"))

# ---- thresholds (measured baselines with margin; tighten as we improve) -----
LIMITS = {
    "greeting_within_s": 30.0,     # first fox audio after join
    "greeting_min_s": 0.8,         # it actually said something
    "reply_within_s": 20.0,        # answer after the question ends
    # 40-80ms holes inside speech. MEASURED FLOOR: Gemini's own raw audio has
    # ~0.51/s before our pipeline touches it (a human recording is 0.10), and
    # client-side capture adds noise, so runs land 0.46-0.94. The limit catches
    # a real regression (the pre-fix pipeline was 1.57) without flapping.
    "micro_gaps_per_s_max": 1.2,
    "identical_frame_ratio_max": 0.10,   # frozen-face detector
    # articulation detector. NOTE: calibrated for this harness's 96x96
    # downsample (a frozen face gives ~0; a talking one ~10). It is deliberately
    # a floor, not a quality score -- identical_frame_ratio is the primary
    # freeze detector and this catches "moving head, dead mouth".
    "mouth_openness_std_min": 4.0,
    "video_fps_min": 20.0,
    "reply_latency_s_max": 12.0,
    "worst_reply_s_max": 12.0,      # every turn, not just the first
    "latency_growth_s_max": 2.5,    # delay must not compound across turns
    "min_turns_answered": 3,
    # NOTE: no high-frequency floor. MEASURED: Gemini's TTS puts 99.77% of its
    # energy below 4kHz and 0.03% above 8kHz -- it is band-limited at the
    # source, so no playout path can produce high-frequency content and such a
    # check could never pass. hf_energy_above_8k is still REPORTED below as a
    # diagnostic when comparing voices/models.
}


def load_question():
    w = wave.open(QUESTION_WAV, "rb")
    sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
    a = np.frombuffer(w.readframes(n), dtype=np.int16)
    if ch == 2:
        a = a.reshape(-1, 2).mean(axis=1).astype(np.int16)
    if sr != SR:  # cheap resample; the content only has to be intelligible
        idx = (np.arange(int(len(a) * SR / sr)) * sr / SR).astype(int)
        a = a[np.clip(idx, 0, len(a) - 1)]
    return a


def hf_energy_ratio(pcm, sr, s_frame, e_frame):
    """Share of spectral energy above 8kHz during speech."""
    a = pcm[int(s_frame * 0.04 * sr) : int(e_frame * 0.04 * sr)].astype(np.float32)
    if len(a) < 2048 or sr <= 16000:
        return 0.0
    spec = np.abs(np.fft.rfft(a * np.hanning(len(a))))
    freqs = np.fft.rfftfreq(len(a), 1.0 / sr)
    total = float((spec ** 2).sum()) or 1e-9
    return float((spec[freqs > 8000] ** 2).sum() / total)


def rms_frames(pcm, frame=None):
    if frame is None:
        frame = int(SPK_SR * 0.04)
    n = len(pcm) // frame
    if n == 0:
        return np.zeros(0)
    x = pcm[: n * frame].reshape(n, frame).astype(np.float32) / 32768.0
    return np.sqrt((x * x).mean(axis=1))


def spans(rms, thr=0.03, gap=20):
    out, cur = [], None
    for i, loud in enumerate(rms > thr):
        if loud:
            cur = [i, i] if cur is None else [cur[0], i]
        elif cur and i - cur[1] > gap:
            out.append(tuple(cur))
            cur = None
    if cur:
        out.append(tuple(cur))
    return out


def micro_gaps_per_s(rms, sp):
    """40-80ms silent holes inside speech -- the audible clicks/static."""
    total_micro, total_frames = 0, 0
    for s, e in sp:
        seg = rms[s : e + 1]
        runs, c = [], 0
        for q in seg < 0.005:
            if q:
                c += 1
            elif c:
                runs.append(c)
                c = 0
        if c:
            runs.append(c)
        total_micro += sum(1 for r in runs if r <= 2)
        total_frames += len(seg)
    return (total_micro / (total_frames * 0.04)) if total_frames else 0.0


class Harness:
    def __init__(self):
        self.audio = bytearray()
        self.audio_lock = threading.Lock()
        self.frames = []           # (t, 96x96 gray uint8)
        self.frames_lock = threading.Lock()
        self.joined = threading.Event()
        self.bot_id = None
        self.t0 = None
        self.stop = False

    # --- media in -----------------------------------------------------------
    def on_video(self, *args):
        # daily-python passes (participant_id, frame[, video_source]); find the frame
        frame = next((a for a in args if hasattr(a, "buffer") and hasattr(a, "width")), None)
        if frame is None:
            return
        try:
            buf = np.frombuffer(frame.buffer, dtype=np.uint8)
            img = buf.reshape(frame.height, frame.width, -1)[:, :, :3]
            g = img.mean(axis=2)
            h, w = g.shape
            ys = (np.linspace(0, h - 1, 96)).astype(int)
            xs = (np.linspace(0, w - 1, 96)).astype(int)
            small = g[np.ix_(ys, xs)].astype(np.uint8)
            with self.frames_lock:
                self.frames.append((time.time() - self.t0, small))
        except Exception:
            pass

    def speaker_reader(self, speaker):
        while not self.stop:
            try:
                data = speaker.read_frames(int(SPK_SR * 0.02))
            except Exception:
                break
            if data:
                with self.audio_lock:
                    self.audio.extend(data)
            else:
                time.sleep(0.005)

    def audio_np(self):
        with self.audio_lock:
            return np.frombuffer(bytes(self.audio), dtype=np.int16).copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--avatar", default=AVATAR)
    ap.add_argument("--quiet-hold", type=float, default=1.6,
                    help="seconds of fox silence before asking the question")
    args = ap.parse_args()

    q = load_question()
    q_secs = len(q) / SR

    print(f"→ starting a call (avatar={args.avatar})", flush=True)
    seat = requests.post(f"{BOT}/api/daily/start", json={"avatar_id": args.avatar}, timeout=60).json()
    if "room_url" not in seat:
        print(f"FAIL: bot did not create a room: {seat}")
        return 2

    h = Harness()
    daily.Daily.init()
    mic = daily.Daily.create_microphone_device("test-mic", sample_rate=SR, channels=1)
    speaker = daily.Daily.create_speaker_device("test-spk", sample_rate=SPK_SR, channels=1)
    daily.Daily.select_speaker_device("test-spk")
    client = daily.CallClient()

    def on_joined(data, error):
        h.joined.set()

    h.t0 = time.time()
    client.join(
        seat["room_url"],
        seat["token"],
        client_settings={
            "inputs": {
                "camera": False,
                "microphone": {"isEnabled": True, "settings": {"deviceId": "test-mic"}},
            }
        },
        completion=on_joined,
    )
    if not h.joined.wait(30):
        print("FAIL: could not join the room")
        return 2

    threading.Thread(target=h.speaker_reader, args=(speaker,), daemon=True).start()

    # attach a video renderer to the bot as soon as it appears
    deadline = time.time() + 30
    while time.time() < deadline and h.bot_id is None:
        for pid, p in (client.participants() or {}).items():
            if pid == "local":
                continue
            h.bot_id = pid
            break
        time.sleep(0.3)
    if h.bot_id:
        client.set_video_renderer(h.bot_id, h.on_video, color_format="RGB")
        print(f"→ watching the fox (participant {h.bot_id[:8]})", flush=True)
        # the browser posts this once audio actually plays; without it the bot
        # waits for its 25s safety fallback and the greeting looks very late
        try:
            requests.post(f"{BOT}/api/telemetry", json={"event": "play_ok", "src": "acceptance"}, timeout=10)
        except Exception as e:
            print(f"  (telemetry ping failed: {e})", flush=True)
    else:
        print("FAIL: the fox never joined the room")
        return 2

    # --- wait for the greeting, then for it to finish -----------------------
    greet_at = None
    quiet_for = 0.0
    last = time.time()
    while time.time() - h.t0 < LIMITS["greeting_within_s"] + 15:
        time.sleep(0.1)
        r = rms_frames(h.audio_np()[-int(SPK_SR * 0.4):])
        loud = bool(len(r)) and float(r.max()) > 0.03
        now = time.time()
        if loud and greet_at is None:
            greet_at = now - h.t0
            print(f"→ fox started talking at {greet_at:.1f}s", flush=True)
        if greet_at is not None:
            quiet_for = 0.0 if loud else quiet_for + (now - last)
            if quiet_for >= args.quiet_hold:
                break
        last = now

    if greet_at is None:
        print("FAIL: the fox never greeted")
        return 1

    # --- multi-turn: real conversations are several exchanges, and delay that
    # --- compounds per turn is invisible to a single-turn test ---------------
    def speak_question():
        for i in range(0, len(q), TICK):
            mic.write_frames(q[i : i + TICK].tobytes())
            time.sleep(TICK / SR * 0.98)
        return time.time()

    def wait_for_reply(since_len, budget):
        t_end = time.time() + budget
        while time.time() < t_end:
            time.sleep(0.1)
            r = rms_frames(h.audio_np()[since_len:])
            if len(r) and float(r.max()) > 0.03:
                return time.time()
        return None

    def wait_until_quiet(hold=1.5, cap=20.0):
        t0_ = time.time()
        quiet = 0.0
        last_ = time.time()
        while time.time() - t0_ < cap:
            time.sleep(0.1)
            r = rms_frames(h.audio_np()[-int(SPK_SR * 0.4):])
            loud_ = bool(len(r)) and float(r.max()) > 0.03
            now_ = time.time()
            quiet = 0.0 if loud_ else quiet + (now_ - last_)
            last_ = now_
            if quiet >= hold:
                return

    turns = int(os.environ.get("FOX_TEST_TURNS", "3"))
    latencies = []
    for t_i in range(turns):
        print(f"→ turn {t_i+1}/{turns}: asking ({q_secs:.1f}s)", flush=True)
        mark = len(h.audio_np())
        q_end = speak_question()
        got = wait_for_reply(mark, LIMITS["reply_within_s"])
        if got is None:
            print(f"   turn {t_i+1}: NO REPLY within {LIMITS['reply_within_s']}s", flush=True)
            latencies.append(None)
        else:
            lat = got - q_end
            latencies.append(lat)
            print(f"   turn {t_i+1}: replied {lat:.1f}s after I stopped talking", flush=True)
        wait_until_quiet()

    time.sleep(2)
    h.stop = True
    ok_lat = [x for x in latencies if x is not None]
    reply_latency = ok_lat[0] if ok_lat else None
    worst_latency = max(ok_lat) if ok_lat else None
    latency_growth = (ok_lat[-1] - ok_lat[0]) if len(ok_lat) >= 2 else 0.0

    # --- metrics ------------------------------------------------------------
    pcm = h.audio_np()
    rms = rms_frames(pcm)
    sp = spans(rms)
    greet_len = ((sp[0][1] - sp[0][0]) * 0.04) if sp else 0.0
    gaps = micro_gaps_per_s(rms, sp)

    with h.frames_lock:
        frames = list(h.frames)
    fps = 0.0
    if len(frames) > 10:
        fps = len(frames) / max(1e-6, frames[-1][0] - frames[0][0])

    # video quality during the fox's speech
    ident_ratio, open_std = 1.0, 0.0
    if sp and frames:
        s_t, e_t = sp[0][0] * 0.04, sp[0][1] * 0.04
        seg = [g for (t, g) in frames if s_t - 0.3 <= t <= e_t + 0.3]
        if len(seg) > 5:
            dup = sum(1 for a, b in zip(seg, seg[1:]) if np.array_equal(a, b))
            ident_ratio = dup / (len(seg) - 1)
            # openness proxy: dark-pixel area in the lower-central face
            open_std = float(np.std([float((g[40:80, 30:70] < 70).sum()) for g in seg]))

    hf = hf_energy_ratio(pcm, SPK_SR, sp[0][0], sp[0][1]) if sp else 0.0
    m = {
        "playout_sr": SPK_SR,
        "hf_energy_above_8k": round(hf, 4),
        "greeting_at_s": round(greet_at, 2),
        "greeting_len_s": round(greet_len, 2),
        "reply_latency_s": round(reply_latency, 2) if reply_latency else None,
        "reply_latencies_s": [round(x, 2) if x else None for x in latencies],
        "worst_reply_s": round(worst_latency, 2) if worst_latency else None,
        "latency_growth_s": round(latency_growth, 2),
        "micro_gaps_per_s": round(gaps, 2),
        "identical_frame_ratio": round(ident_ratio, 3),
        "mouth_openness_std": round(open_std, 1),
        "video_fps": round(fps, 1),
        "audio_secs_captured": round(len(pcm) / SR, 1),
        "frames_captured": len(frames),
    }

    checks = [
        ("greeting arrives", m["greeting_at_s"] is not None and m["greeting_at_s"] <= LIMITS["greeting_within_s"],
         f'{m["greeting_at_s"]}s <= {LIMITS["greeting_within_s"]}s'),
        ("greeting is a sentence", greet_len >= LIMITS["greeting_min_s"],
         f'{greet_len:.1f}s >= {LIMITS["greeting_min_s"]}s'),
        ("replies to speech", reply_latency is not None,
         f'{m["reply_latency_s"]}s' if reply_latency else "NO REPLY"),
        ("reply is prompt", (reply_latency or 99) <= LIMITS["reply_latency_s_max"],
         f'{m["reply_latency_s"]}s <= {LIMITS["reply_latency_s_max"]}s'),
        ("answers every turn", len(ok_lat) >= LIMITS["min_turns_answered"],
         f'{len(ok_lat)}/{turns} turns answered'),
        ("no turn is slow", (worst_latency or 99) <= LIMITS["worst_reply_s_max"],
         f'worst {m["worst_reply_s"]}s <= {LIMITS["worst_reply_s_max"]}s  turns={m["reply_latencies_s"]}'),
        ("delay does not compound", latency_growth <= LIMITS["latency_growth_s_max"],
         f'grew {latency_growth:+.1f}s across turns <= {LIMITS["latency_growth_s_max"]}s'),
        ("voice is continuous", gaps <= LIMITS["micro_gaps_per_s_max"],
         f'{gaps:.2f} gaps/s <= {LIMITS["micro_gaps_per_s_max"]}'),
        ("face is not frozen", ident_ratio <= LIMITS["identical_frame_ratio_max"],
         f'{ident_ratio:.3f} identical <= {LIMITS["identical_frame_ratio_max"]}'),
        ("mouth articulates", open_std >= LIMITS["mouth_openness_std_min"],
         f'std {open_std:.0f} >= {LIMITS["mouth_openness_std_min"]}'),
        ("video is smooth", fps >= LIMITS["video_fps_min"],
         f'{fps:.1f} fps >= {LIMITS["video_fps_min"]}'),
    ]

    print("\n" + "=" * 62)
    ok = True
    for name, passed, detail in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name:24s} {detail}")
        ok = ok and passed
    print("=" * 62)
    print("  " + json.dumps(m))
    print(f"\n{'ALL CHECKS PASSED' if ok else 'REGRESSION — see FAIL lines above'}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"metrics": m, "limits": LIMITS, "passed": ok}, f, indent=2)

    try:
        client.leave()
        client.release()
    except Exception:
        pass
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
