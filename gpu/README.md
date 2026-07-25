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

## Env (`~/fox-pipecat/.env`, not in git)

    GEMINI_API_KEY=...        DAILY_API_KEY=...
    DITTO_WARP_BATCH=4        DITTO_DECODE_BATCH=4
    FOX_OVERLAP=50            # motion-clip granularity; 50 halves in-flight
                              # depth (5.8s -> 2.8s) at no throughput cost
    FOX_LEDGER_TARGET=6       FOX_WARM_WINDOWS=0
    FOX_AV_OFFSET_TICKS=0     FOX_RECORD=0   # 1 = dump /tmp/fox_rec.mp4

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
