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
