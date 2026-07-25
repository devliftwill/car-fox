# GPU side — self-hosted Car Fox avatar

Runs on the A100 VM `fox-neural-mouth` (us-central1-b) in `~/fox-pipecat/`.
Pipeline: visitor mic → Daily → Pipecat → Gemini 3.1 Flash Live (Puck voice)
→ Ditto face engine on the A100 → Daily → browser.

- `fox_pipecat_bot.py` — FastAPI service on :8012. `POST /api/daily/start`
  creates a Daily room, mints tokens, runs the pipeline. `/api/offer` is the
  older SmallWebRTC path (kept as a fallback).
- `ditto_video_service.py` — the bridge: feeds Gemini's audio to Ditto, pairs
  each 200ms audio window with the exact 5 frames it produced, and writes both
  media tracks to Daily's devices from dedicated threads.
- `ditto-patches/` — patches applied to the vendored `~/ditto-talkinghead`
  checkout, plus the probes used to measure it. Re-apply after any fresh
  clone: `python patch_decoder.py && python patch_batch_decode.py && python patch_batch_warp.py`

## Why the patches exist (measured, not guessed)

The engine could only sustain **~21 fps** while realtime needs **25 fps**, so it
fell behind ~4 frames every second *forever*: latency grew without bound, the
greeting ended up buried tens of seconds deep, and audio had to be dropped to
keep up. `stage_probe.py` localized it — `decode_f3d`'s queue was the only one
backing up, and the A100 sat at ~65%.

Cause: the decoder and warp stages each ran **one 512×512 frame per forward
pass** with a GPU→CPU sync per frame, plus per-frame numpy post-processing.

Fixes: batch both stages (`DITTO_WARP_BATCH`, `DITTO_DECODE_BATCH`, default 4),
do the decoder's post-processing on the GPU, and reuse the source tensor
(identical every frame for a photo avatar) instead of re-uploading 8.4MB/frame.
Result: **~25.2 fps sustained**, deficit bounded (oscillates 125–151 frames
instead of climbing), so latency is now constant instead of compounding.

## What is NOT a throughput lever (measured, stop trying these)

- **`DITTO_STEPS`.** Steps 8, 9 and 10 produce *byte-identical* frame counts in
  `rate_probe.py`. Diffusion is nowhere near the limiter — the per-frame render
  path is. Steps is a pure quality knob, which is also why `DITTO_STEPS=3` held
  framerate while freezing the face. Leave it at 10.
- **Making a stage faster, generally.** `deficit` in `rate_probe.py` is standing
  *fill*, not a shortfall — the probe feeds at realtime and production matches
  it. Shrinking a stage's cost does not shrink the window the model must fill.
  Three separate wins (hubert to CUDA, cached putback mask, buffer reuse) each
  moved steady-state production by <1%. Use `FOX_OVERLAP` for latency; use
  throughput work only to buy headroom for a lower overlap.
- **`onnxruntime` packaging is still worth keeping correct**: the CPU wheel
  shadows `onnxruntime-gpu` and silently forces CPU execution. Verify with
  `ort.InferenceSession(...).get_providers()` — it must list
  `CUDAExecutionProvider`. (Uninstalling the CPU wheel breaks the GPU one; they
  share a directory. Reinstall with `--force-reinstall onnxruntime-gpu==1.23.2`
  and re-pin `protobuf<7` and `sympy==1.13.1` afterwards.)

## Env (`~/fox-pipecat/.env`, not in git)

    GEMINI_API_KEY=...        DAILY_API_KEY=...
    DITTO_WARP_BATCH=4        DITTO_DECODE_BATCH=4
    FOX_OVERLAP=50            # motion-clip granularity; valid_clip = 80-overlap.
                              # This is the ONLY real latency knob: it sets how
                              # much pipeline has to fill before a frame comes
                              # out. Measured fill: overlap 40 = 80 frames
                              # (3.2s), 50 = 60 frames (2.4s), 60 = 95 and
                              # CLIMBING at 23.9 fps (cannot sustain realtime).
                              # History: 50 used to compound (7.4->8.7->10.6s)
                              # and this file said never raise it. That was
                              # true BEFORE the render path got fast enough
                              # (batching + hubert on GPU + putback cache). Now
                              # 50 holds 4 turns at 5.55/5.47/5.35/5.44s with
                              # +0.0s growth and 40 measures WORSE. Do not go to
                              # 60 without first making the render path faster.
    FOX_LEDGER_TARGET=6       FOX_WARM_WINDOWS=0
    FOX_AV_OFFSET_TICKS=0     FOX_RECORD=0   # 1 = dump /tmp/fox_rec.mp4
    FOX_SPEECH_HANG=2         # speech hangover in windows (400ms). At 10 (2s)
                              # trailing dead air got queued for playout and
                              # added up to 2s of delay PER TURN.
    FOX_VAD_START=START_SENSITIVITY_LOW   # HIGH let speaker bleed into the mic
                              # interrupt the fox mid-sentence ("got cut off")

## Verify before you ship: `acceptance_test.py`

    cd ~/fox-pipecat && python acceptance_test.py     # 8 checks, non-zero exit on failure

Joins a real Daily room headlessly, speaks a question, and grades the media:
greeting, reply, latency, voice continuity, frozen-face, mouth articulation,
fps. Validated against a known-bad build (`DITTO_STEPS=3`) — it fails on mouth
articulation, and note the frozen-frame check CANNOT see that regression
because WebRTC compression makes every frame differ slightly.

## Measured audio facts (stop re-litigating these)

- **Gemini's TTS is band-limited at the source**: 99.8% of energy below 4kHz,
  0.03% above 8kHz. No playout change can add fidelity that isn't there.
- The remaining short silences inside speech (~0.5/s) are **Gemini's own**
  (measured pre-pipeline with `FOX_RECORD_RAW=1`); a human recording is 0.10/s
  and the client hears 0.46-1.04/s. Our path is ~transparent.
- Playout runs at `FOX_PLAY_SR` (24000 = Gemini's native rate). 16k is used
  ONLY to drive the lip model, derived through one continuous resampler so the
  audio heard and the frames shown cannot drift apart.
- Voice/latency trade-off, both measured through the gate:
  `FOX_GEMINI_MODEL=models/gemini-3.1-flash-live-preview` -> reply ~7.9s,
  4-8kHz share 0.33%; `...gemini-2.5-flash-native-audio-preview-12-2025` ->
  4.3x more 4-8kHz energy (brighter voice) but reply ~15s (fails the gate).

## Session recordings (troubleshooting a real call)

Every call records what the visitor actually receives — each 40ms audio slice
paired with the frame shown alongside it — and writes the media and the trace
when the call ends:

    /var/tmp/fox-session-<ts>.mp4    what they saw and heard
    /var/tmp/fox-session-<ts>.json   per-window trace + counters

Reachable without shell access (needs the site passcode cookie):

    /api/neural/diag?path=recordings
    /api/neural/diag?path=recording/fox-session-<ts>.mp4
    /api/neural/diag?path=turns      # think / intake / engine / playout per turn

Memory-bounded: frames are JPEG-encoded into a ring of `FOX_RECORD_SECS`
(default 90s, ~80MB). `FOX_RECORD_SESSIONS=0` disables. Costs no measurable
throughput — the gate passes with it on.

Counters worth reading first: `pair_drift` (audio<->frame pairing, must be 0),
`interruptions` (more than one per turn means mic echo is truncating the fox),
`speech_audio_dropped` (must be 0), `playout_underruns`.

**Do not trust the automated A/V-sync correlation.** On a real recording it
gave 0.02-0.20 correlation with lags scattered from +120ms to -840ms — the
mouth-openness proxy is too weak on a stylized 3D fox to conclude anything.
Watch the mp4 instead.

## Measuring it honestly

`FOX_RECORD=1` makes the bridge mux exactly what it transmits — each 40ms audio
slice with the frame shown alongside it — into `/tmp/fox_rec.mp4`. Analyze that
file; do not trust energy/frame-count proxies. Two traps that produced months of
false "verified" readings:

- `requestVideoFrameCallback` returns 0 on a hidden page. Use
  `video.getVideoPlaybackQuality().totalVideoFrames` deltas.
- Frame-rate counters can't tell a moving fox from a still frame being re-clocked,
  and pixel-diff "sync" metrics are dominated by head sway, not mouth shape.
  Locate the mouth from the data (highest-variance pixels), or just watch the clip.
