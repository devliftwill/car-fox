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

## Where the time actually goes — profile before optimizing

`py-spy dump --pid <probe>` settles this in seconds, and it has now twice
contradicted what looked obvious:

1. First profile: main thread stuck in `onnxruntime` running the hubert audio
   features **on CPU** (the CPU wheel was shadowing `onnxruntime-gpu`).
2. Second profile, after that fix: **every render stage idle** on an empty
   queue, and `audio2motion` — the LMDM diffusion — the only busy worker, with
   the GPU at 48%. The render path was never the ceiling. Diffusion was.

The win that followed: `guided_forward` ran two sequential transformer passes
per ddim step (unconditional + conditioned, classifier-free guidance). They are
independent, so `patch_cfg_batch.py` stacks them on the batch axis — same
weights, same inputs, half the kernel launches. Verified identical on real
inputs with `DITTO_CFG_VERIFY=1`: max relative difference **2e-7**, i.e. fp32
rounding. That alone took overlap 60 from "23.9 fps, deficit climbing" to
"25.0 fps, deficit flat at 40" and ~1s off every reply.

## What is NOT a throughput lever (measured, stop trying these)

- **`DITTO_STEPS`.** Steps 8, 9 and 10 produce *byte-identical* frame counts in
  `rate_probe.py` at overlap 50 — production is capped by the realtime feed, so
  spare diffusion speed is invisible there. It is a quality knob, which is why
  `DITTO_STEPS=3` held framerate while freezing the face. Leave it at 10.
- **`torch.compile`** on the warp/decoder nets: produced **zero frames in 60s**
  — the compile never finished. Unusable on a wake-on-demand box regardless.
- **`cudnn.benchmark = True`**: **halves** throughput (25.0 -> 12.4 fps). Batch
  sizes vary (8 plus a short tail), so it re-autotunes on every new shape.
- **Bigger batches** (16 vs 8): no change.
- **Making a *render* stage faster, generally.** `deficit` in `rate_probe.py` is
  standing *fill*, not a shortfall — the probe feeds at realtime and production
  matches it. Three wins there (hubert to CUDA, cached putback mask, buffer
  reuse) each moved steady-state production by <1%. Latency comes from
  `FOX_OVERLAP`; throughput work only matters as headroom to lower it.

⚠️ `core/models/{warp_network,decoder}.py` have `.orig` backups that predate the
*batching* patches. Restoring them silently removes the `.batch()` methods the
patched pipeline calls, and throughput collapses. Re-run `patch_decoder.py`,
`patch_batch_decode.py`, `patch_batch_warp.py` after any revert.
- **`onnxruntime` packaging is still worth keeping correct**: the CPU wheel
  shadows `onnxruntime-gpu` and silently forces CPU execution. Verify with
  `ort.InferenceSession(...).get_providers()` — it must list
  `CUDAExecutionProvider`. (Uninstalling the CPU wheel breaks the GPU one; they
  share a directory. Reinstall with `--force-reinstall onnxruntime-gpu==1.23.2`
  and re-pin `protobuf<7` and `sympy==1.13.1` afterwards.)

## Env (`~/fox-pipecat/.env`, not in git)

    GEMINI_API_KEY=...        DAILY_API_KEY=...
    DITTO_WARP_BATCH=4        DITTO_DECODE_BATCH=4
    FOX_OVERLAP=60            # motion-clip granularity; valid_clip = 80-overlap.
                              # The ONLY real latency knob: it sets how much
                              # pipeline must fill before a frame comes out.
                              # Measured fill, all at DITTO_STEPS=10:
                              #   40 -> 80 frames (3.2s)
                              #   50 -> 60 frames (2.4s)
                              #   60 -> 40 frames (1.6s)   <- shipped
                              #   65 -> 36 frames, but replies DRIFT upward
                              #         (4.54/4.86/5.46/5.55 over 4 turns)
                              #   70 -> 130 and climbing, 22.3 fps. Dead.
                              # 60 only became reachable once CFG was batched
                              # (see patch_cfg_batch.py); before that it ran
                              # 23.9 fps with the deficit climbing 71->81->95.
                              # Raising this requires making diffusion faster
                              # FIRST, then re-running the multi-turn gate.
    FOX_SINGLE_CLOCK=1        # ONE clock owns video. The audio writer thread
                              # writes each 40ms tick's audio slice AND that
                              # tick's frame to the camera device. At 0 the old
                              # two-clock path runs (pacer samples a shared
                              # `_latest` on its own metronome) and the beat
                              # between them handed the device the SAME frame
                              # 107 times in ~50s = ~2 stutters/sec of judder.
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

## Judder: why "25.0 fps" proved nothing

Will reported "still very choppy" on a build the gate had passed at 25.0 fps.
Both were true. Video ran through **two free-running 40ms metronomes** — the
audio writer set `pacer._latest`, and the pacer's own thread sampled it — with
no phase relationship. When the pacer sampled early it wrote the previous frame
again; the average stayed exactly 25 fps while motion advanced 40/40/80/0ms.

Nothing in the harness could see it:

- `video_fps` counts *arrivals*, and duplicates arrive right on time.
- `identical_frame_ratio` reads 0.000 because WebRTC compression makes even a
  duplicated frame differ by a few LSBs.
- the **session recording is written from the audio clock**, upstream of the
  beat, so the mp4 looks fine too.

So the bot counts it directly (`video_dup_writes`, `video_skipped_frames`) and
the gate asserts zero. Validated the way `DITTO_STEPS=3` was: run with
`FOX_SINGLE_CLOCK=0` and `video is smooth` still PASSES at 25.0 fps while
`video clock is clean` FAILS with 107 duplicate writes.

`tick_jitter_ms_p95` guards the other half — the master clock must stay at 40ms,
so per-tick work cannot creep back onto it. The recording's JPEG encode used to
run there; moving it to a background thread took max jitter 60.15ms -> 4.37ms.

**Do not measure smoothness from the recording or from fps.** Ask the bot.

### The bigger one: frame aliasing (my own regression)

`video_dup_writes` only increments on the two-clock path, so once
`FOX_SINGLE_CLOCK=1` shipped it was **always 0** — it proves the beat is gone
and nothing more. Underneath it sat a far worse defect I had introduced myself,
caching `result_buffer` in `putback` for the 786KB/frame saving. That function
ends with `return self.result_buffer`, so every frame in a batch aliased one
buffer and each 200ms window transmitted its last frame five times:

    80% of transmitted frames byte-identical  ->  ~5 effective fps

Every instrument said it was fine. fps 25.0 (duplicates arrive on time),
identical_frame_ratio 0.000, clock counters clean, client-side WebRTC stats
showing zero freezes and zero dropped frames — all true, all irrelevant. The
mp4 read ~12% rather than 80% because x264 reconstructs identical inputs
slightly differently, so the recording is unreliable in **both** directions.

What found it: CRC the raw 786KB frame bytes before anything compresses them,
on the recording's background thread. Now `frames are distinct` in the gate,
reading 0.00% / 25.0 effective fps. **Any future "cache this buffer" idea in the
render path must be checked against that counter, not against fps.**

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
