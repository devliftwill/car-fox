# Ditto performance levers — rescan 2026-07-26

Read-only audit of the vendored SDK + upstream docs. NOTHING here is applied yet.

Headline: the diffusion stage runs at ~0.66%% of A100 fp32 peak while nvidia-smi
reads ~48%% busy — the workload is launch/dispatch-bound by roughly 25x. Levers that
remove kernel launches beat levers that speed up arithmetic, by an order of magnitude.

---

Every claim below is verified against the live checkout; nothing was run on the GPU (greps, `sed`, and one `CUDA_VISIBLE_DEVICES=""` attribute read).

---

# The number that determines the whole ranking

Per `forward()` call at batch 1, seq 80, d=512, ff=1024 (`core/models/modules/LMDM.py:30-40`):

| block | FLOPs |
|---|---|
| `cond_projection` + `cond_encoder` (2 layers) + `non_attn_cond_projection` — `model.py:391-400` | **0.79 GFLOP** |
| `input_projection` + `seqTransDecoder` (8 layers) + `final_layer` — `model.py:381,420,422` | **4.32 GFLOP** |
| total | **5.11 GFLOP** |

Per window: 10 DDIM steps × CFG batch 2 = 20 forward-equivalents ≈ **102 GFLOP**. At `FOX_OVERLAP=60`, `valid_clip_len = 80-60 = 20` (`audio2motion.py:85`), so 25 fps = **1.25 windows/s** → **128 GFLOP/s sustained**.

A100 fp32 without tensor cores is 19.5 TFLOP/s. **We are at 0.66% of peak while `nvidia-smi` reads 48% busy.** The math in a window is ~13 ms; the GPU is occupied ~384 ms. **This workload is launch- and dispatch-bound by roughly 25×.**

That single fact orders everything: levers that **remove kernel launches and CPU dispatch** beat levers that make each kernel's arithmetic faster, by more than an order of magnitude. It also retro-explains every result you already have — CFG batching (halved launch count) was the big win; `cudnn.benchmark` (re-autotunes, more launches) halved throughput; `torch.compile` never finished.

**Confirmed absent everywhere** (both `~/ditto-talkinghead/core/` and `/Users/will/Repos/car-fox/gpu/`): `CUDAGraph`, `torch.cuda.Stream`, `allow_tf32`, `set_float32_matmul_precision`. And read live from the venv:

```
torch 2.6.0+cu124
matmul.allow_tf32 = False     <- LMDM transformer runs true fp32
cudnn.allow_tf32  = True      <- render convs already get TF32
float32_matmul_precision = highest
```

---

# Ranked levers

## 1. CUDA Graphs over the whole 10-step DDIM loop — **highest expected value**

**Why first:** it is the only lever that attacks the 25× overhead directly *and* is numerically safe by construction. Graph capture replays the identical kernels in the identical order with the identical arguments — it changes launch mechanism, not arithmetic. Every other large lever on this list buys its gain by changing what the model computes. This one does not, which is decisive given that your two worst historical regressions (`DITTO_STEPS=3`, the aliased `result_buffer`) were both invisible to instrumentation.

**What it is:** `LMDM.ddim_sample` (`core/models/modules/LMDM.py:127-153`) is a fixed 10-iteration loop with no data-dependent control flow, and the per-step constants are *already* pre-materialized as device tensors at setup: `time_cond_list` (`:111-112`), `noise_list`/`alpha_next_sqrt_list`/`sigma_list`/`c_list` (`:118-125`). The only per-call inputs are `kp_cond`, `aud_cond` (`core/models/lmdm.py:131-134`) and `x = torch.randn(shape, device=...)` (`:135`). All shapes are static forever: `(1,80,265)`, `(1,265)`, `(1,80,1103)`, CFG-widened to batch 2 at `model.py:347-353`. Capture once, then replay ~2000 launches as one.

Capture prerequisites I verified: `clip_denoised=False` (`LMDM.py:16,27`) so `maybe_clip` is a passthrough; the model is in `eval()` (`LMDM.py` `load_model`) so dropout is inert; `RotaryEmbedding` caches its freqs by `seq_len` in a Python dict (`rotary_embedding_torch.py:102,116-118`) and returns a stored device tensor — safe **after warmup**, which the standard capture recipe does anyway.

**Expected gain:** if launch overhead is ~25× the math, removing most of it is worth **1.5–3× on the diffusion stage**. That is a *reasoned estimate from the 0.66%-of-peak measurement, not a measured result* — the residual after graphs will be per-kernel memory latency, which graphs do not remove. I'd bet on ≥1.5× and would not be shocked by 3×.

**Effort:** ~1 day. Unlike `torch.compile` (README:59-60, "zero frames in 60s") capture is record/replay — seconds, no codegen, no autotuning, and no shape sensitivity to reproduce the `cudnn.benchmark` failure.

**Risk:** low numerically, but two real implementation traps. (a) RNG: `torch.randn` at `:135` is inside the captured region; PyTorch handles graph-safe RNG via philox offset capture, but if it is mishandled **every window replays the same noise** — which would look like a subtly repeating motion loop and would *pass every check you own*. Mitigate by hoisting `x = randn(...)` outside the graph into a static buffer you fill per call. (b) Capture happens while six worker threads are live (`stream_pipeline_online.py:249-256`); default `cudaStreamCaptureModeGlobal` will error or capture foreign work. Capture during `setup()` before feeding starts, or use `capture_error_mode="thread_local"`.

**How to measure:** throughput with `rate_probe.py` at `PROBE_OVERLAP=65` and `70`, not 60 — per README:98-99 the win only shows as *permission to lower latency*. For correctness, the `DITTO_CFG_VERIFY` harness (`model.py:356-363`) compares graph output against eager on real inputs; extend it to assert successive windows produce *different* `x` (guards trap (a) — nothing else would).

---

## 2. Hoist the audio-conditioning block out of the DDIM loop *and* out of the CFG batch

**What it is:** two stacked redundancies in `MotionDecoder.forward`, both provable from the source.

- **Loop-invariant.** `ddim_sample` sets `cond = aud_cond` once (`LMDM.py:132`) and passes it unchanged on all 10 steps (`:141`). But `cond_projection` → `abs_pos_encoding` → `cond_encoder` (`model.py:391-394`) is recomputed identically every step.
- **Half of it is dead, not merely redundant.** `model.py:397`: `cond_tokens = torch.where(keep_mask_embed, cond_tokens, null_cond_embed)`. For the unconditional half of our CFG batch, `keep_mask` is `False` (`model.py:344`), so the freshly computed `cond_tokens` for that half is **discarded outright**. Same at `:411` for `cond_hidden`. We compute the 2-layer transformer encoder on two identical copies and throw one away.

Net: the cond block is evaluated **20× per window; 1× is needed**.

**Fix:** compute `cond_tokens`/`cond_hidden` once at batch 1 outside the loop, then build the batch-2 tensor as `cat([null_cond_embed.expand(...), cond_tokens], 0)` — the `torch.where` disappears with a constant mask, so this is a value-identical rewrite.

**Expected gain:** **~15% of diffusion FLOPs** (19 × 0.79 = 15.0 GFLOP saved of 102) and **~19% of transformer layer-launches** (200 layer-evals/window → 162). This is *computed from the shapes above, not measured*, but it is arithmetic on verified dimensions rather than a guess. It holds either way: without graphs it's a launch saving, with graphs it's a math saving.

**Effort:** half a day. Same shape of change as `patch_cfg_batch.py`.

**Risk:** low. Value-identical up to cuBLAS picking a different GEMM algorithm at batch 1 vs 2 — i.e. fp32 rounding, the same 2e-7 class of difference you already accepted for CFG batching.

**How to measure:** `DITTO_CFG_VERIFY=1` (`model.py:356-363`) — this is exactly what it was built for. Then `rate_probe.py` at `PROBE_OVERLAP=65/70`.

**Footnote, same patch, smaller:** `input_projection` (`model.py:381`) consumes `cat([x, cond_frame.repeat(...)])` (`:379`). `cond_frame` is loop-invariant, so `W[:,265:] @ cond_frame + b` can be precomputed once per window as a bias. Worth ~21 MFLOP/step — negligible FLOPs, but it removes a `repeat` + a wide `cat` allocation from every step, which is not negligible when you are dispatch-bound.

---

## 3. `eta = 0` (deterministic DDIM) to unlock fewer steps — biggest upside, biggest quality risk

**What it is:** `core/models/modules/LMDM.py:97` hard-codes `eta = 1`, which at `:118` gives a non-zero `sigma` and injects fresh noise at every step (`:143`). That is fully stochastic ancestral sampling. `eta = 0` collapses `sigma` to 0 and gives the standard deterministic DDIM sampler, which is **specifically what makes low step counts viable** — it is the reason DDIM exists.

**This reframes your "DITTO_STEPS is not a lever" finding.** README:55-58 concluded that from steps 8/9/10 being byte-identical in `rate_probe.py` **at overlap 50**. At overlap 50, `valid_clip_len = 30` → 0.83 windows/s; at overlap 70 it is 2.5 windows/s — **3× the diffusion load**. The steps knob was measured at an operating point where diffusion was not the binding constraint, so it *could not* have shown. And `DITTO_STEPS=3` froze the face at `eta=1`, where the injected noise term is proportionally largest at low step counts. Nobody has tried few steps with `eta=0`.

**Expected gain:** if steps 10 → 5 becomes viable, that is a **2× on the bottleneck** — larger than anything else here. **This is a guess.** It is conditional on quality holding, and I have no evidence either way; upstream's "10 vs 50 is minimal disparity" claim is at `eta=1` and says nothing about `eta=0` at 5.

**Effort:** one line to test throughput (~1 hour). The quality validation is the expensive part — days, and partly manual.

**Risk: highest on this list, and it lands squarely in your blind spot.** It changes the sampled motion distribution. Removing stochasticity could flatten motion amplitude (the `DITTO_STEPS=3` failure mode) *or* make it subtly repetitive across windows. Critically: `mouth_openness_std_min: 4.0` is documented as **"deliberately a floor, not a quality score"** (`acceptance_test.py:53-57`) — so a lever that makes motion *noisier* scores **better**, and a lever that makes it *smoother but correct* scores worse. This check cannot grade this lever in either direction.

**How to measure:** `rate_probe.py` at `PROBE_OVERLAP=70` for throughput. For quality the gate is **not sufficient** — run the multi-turn latency-drift gate (`delay does not compound`) and then **watch `/var/tmp/fox-session-*.mp4`**, per README:150 and :215. Do not accept this on `mouth articulates` alone.

---

## 4. Kill the per-frame `.cpu()` syncs — starting with the stitch network — then per-stage CUDA streams

**What it is:** `core/models/stitch_network.py:21-26` runs, **per frame**, `torch.from_numpy(...).to(device)` → forward → `.cpu().numpy()`. No autocast, no batch, and — unlike warp (`warp_network.py:14`) and decoder (`decoder.py:14`) which you patched — **no `.batch()` method exists**, and `_motion_stitch_worker` (`stream_pipeline_online.py:393-406`) is the only render worker with no drain loop. It fires 25×/second, driven from `motion_stitch.py:487`.

**Why this is not "just another render-path win"** (README:64-68 correctly says those move production <1%): all six worker threads submit to the **default stream** — grep confirms zero `torch.cuda.Stream` anywhere. `.cpu()` on a CUDA tensor is a **full stream sync**. In a workload that is dispatch-bound by 25×, the CPU staying *ahead* queueing launches is the only thing keeping the GPU fed. Each `.cpu()` drains that queue to zero and the GPU idles while it refills. Stitch alone does that **25 times a second, into the middle of the diffusion window**. That is a concrete mechanism by which a render-stage fix helps *diffusion*, and it is the best available explanation for "GPU at 48% with only the diffusion worker busy" (README:41-43).

Related and currently free-but-inert: every H2D/D2H here is from **pageable** numpy (`warp_network.py:42-44`, `decoder.py:24`), so `non_blocking=True` is a no-op today. Pinned staging buffers would make async copies real. Same for the warp→decode handoff, which goes device → `.float().cpu().numpy()` (`warp_network.py:38`) → `queue.Queue` → back to device (`decoder.py:24`); keeping a CUDA tensor on the queue removes two syncs per batch.

**Expected gain:** **guess, 5–15% on diffusion throughput.** The mechanism is sound; the magnitude is not measured. Batching stitch alone (8-wide, matching warp/decode) is the cheap first cut and takes 25 syncs/s → ~3/s.

**Effort:** stitch batching, ~2 hours (copy the drain-loop pattern from `_warp_f3d_worker`, `stream_pipeline_online.py:357-384`). Per-stage streams + pinned buffers, ~1 day.

**Risk: this is the exact shape of the bug that burned you.** Batching stitch means writing a `.batch()` that slices one output tensor into per-frame results — precisely the pattern that, in `putback`, produced `return self.result_buffer` and made 80% of transmitted frames byte-identical while fps read 25.0 and `identical_frame_ratio` read 0.000 (README:156-172). Any per-frame slice must be a distinct object.

**How to measure:** `stage_probe.py` for queue depths, `rate_probe.py` at `PROBE_OVERLAP=65/70`. For the aliasing risk, the **only** instrument that works is `frame_content_dupes` / `frames are distinct` (`acceptance_test.py:445-446`) — check that counter, never fps.

---

## 5. TF32 for fp32 matmuls — one line, but I expect little

**What it is:** verified live above — `matmul.allow_tf32 = False`, `float32_matmul_precision = "highest"`. The LMDM is a pure-matmul 8-layer d=512 transformer running true fp32 on a card with TF32 tensor cores. `torch.set_float32_matmul_precision("high")`.

**Expected gain: honestly, 0–5% — and I want to correct the framing that this is the cheapest big win.** The headline "TF32 is ~8× fp32" is irrelevant here: we are at **0.66% of fp32 peak**, so making the math 8× faster shrinks something that is ~4% of the wall clock. Note also `cudnn.allow_tf32` is *already* `True`, so the conv-heavy render path already has it — and is under fp16 autocast besides (`warp_network.py:26`, `decoder.py:23`). It is worth doing because it costs one line and cannot reproduce either recorded failure (no shape churn, no autotuning), not because it is large.

**Effort:** minutes. **Risk:** low — TF32 keeps fp32 range with ~10 bits of mantissa; the LMDM output feeds a motion representation, not pixels. Upstream keeping `lmdm*` at fp32 in their TRT export (`scripts/cvt_onnx_to_trt.py:114`) is about fp16's *range*, not TF32's precision, so it is weak evidence here. **Measure with** `DITTO_CFG_VERIFY` then `rate_probe.py`.

---

## 6. Two free CPU-side wins in a dispatch-bound regime (nobody has proposed these)

**(a) `torch.inference_mode()` instead of `torch.no_grad()`.** `ddim_sample` is decorated `@torch.no_grad()` (`LMDM.py:127`). `inference_mode` additionally skips view/version-counter tracking, cutting per-op CPU dispatch cost. When the constraint is *how fast Python can issue ~2000 launches*, per-op CPU cost is the constraint. Gain: **guess, 1–3%.** Effort: one line. Risk: none for output values; the returned tensor cannot be used in autograd, which nothing here does.

**(b) `sys.setswitchinterval()`.** Ten-plus Python threads share one GIL — six SDK workers (`stream_pipeline_online.py:249-256`) plus four in the service (`ditto_video_service.py:170,188,478,481`). The default 5 ms switch interval preempts the diffusion thread ~200×/second mid-launch-burst. Raising it (25–50 ms) lets it run uninterrupted. Gain: **guess, 0–5%.** Effort: one line. **Risk:** it can worsen the 40 ms master clock's jitter — which you *can* see, via `tick_jitter_ms_p95` (`acceptance_test.py:452-453`, must stay ≤ its limit). That check makes this safe to try.

Both are numerically inert, so `rate_probe.py` at `PROBE_OVERLAP=65` grades them alone.

---

## 7. NVIDIA MPS — real, but it does not help what you ship

Verified: `/tmp/nvidia-mps` absent, no `nvidia-cuda-mps-control` process, `compute_mode = Default` (which is the mode MPS needs). Without MPS the driver **time-slices CUDA contexts**, so kernels from separate processes never overlap. Each session is its own process — `_sdk` is a module singleton and `_active_owner` (`ditto_video_service.py:96,468-469,498`) permits exactly one session per process.

That explains your curve precisely: one session leaves the card idle ~half the time, a second context interleaves into the stalls (25.0 → 37.5), a third finds no more gaps (37.7, flat). It also **rules out memory bandwidth** — a bandwidth wall would not have yielded +50% for a second process.

**But:** production serves one session at a time by construction. MPS raises the *aggregate* ceiling, which is a future-concurrency lever, not a latency lever. It will not buy you a single millisecond of `FOX_OVERLAP` headroom. Effort: one daemon, no code. Risk: low. Measure: two concurrent `rate_probe.py` runs. https://docs.nvidia.com/deploy/mps/

---

## 8. `flag_stitching=False` and `max_size=512` for uploaded avatars — small, honest

`flag_stitching` (`stream_pipeline_online.py:141`) defaults `True` and we never override it; setting it `False` deletes lever #4's per-frame round trip entirely rather than batching it. Visible quality change at the crop seam — a real trade, worth one A/B.

`max_size`: **for the fox it is inert.** It is passed only as `max_dim` to the loader (`core/atomic_components/loader.py:19-22,39-46`), which downscales only when `max(h,w) > max_dim`, and `~/LiveTalking/data/avatars/fox_ditto/source.png` is 512×512 against our `max_size=1024` (`ditto_video_service.py:440`). For 1000×1000 uploaded characters it saves CPU putback work and bandwidth — **zero GPU effect**. There is no output-resolution knob at all: 512 is baked into the crop (`source2info.py:93`) and the `SPADEDecoder` head.

---

## 9. `guidance_weight` 2 → 1 — halves the bottleneck, but it is a quality knob wearing a performance costume

`self.guidance_weight = 2` is hard-coded at `core/models/modules/LMDM.py:28` and consumed at `model.py:365` as `unc + (cond-unc)*w`. At `w=1` the unconditional branch is arithmetically redundant and the CFG batch of 2 collapses to 1 — **halving diffusion FLOPs and launches.** Nothing else on this list is that large for that little code.

I rank it here anyway because classifier-free guidance strength *is* lip-sync strength. Lowering it will make the mouth track the audio less tightly, and **`mouth_openness_std` is a floor, so weaker-but-still-moving lips can pass.** If you try it, sweep 2 → 1.5 → 1.0 and grade by watching the mp4, not by the gate.

---

## 10. Single process, N sessions, shared weights, cross-session batching

The batch APIs are already session-agnostic — `WarpF3D.batch(triples)`, `DecodeF3D.batch(features)`, and `guided_forward` handles arbitrary batch `b` (`model.py:342`). What blocks it is that `StreamSDK.setup()` both mutates instance state and *recreates the worker threads* (`stream_pipeline_online.py:249-259`), plus the `_active_owner` singleton. Payoff: one CUDA context (no time-slicing, so this subsumes MPS), one copy of ~2.2 GB of weights, and warp/decode batches filled across sessions. Effort: **weeks.** Concurrency lever only — no single-session latency benefit.

---

## 11. TensorRT — I'd bet a drop-in comes out *slower*, and its failure mode is invisible to you

Verified state: `checkpoints/` holds only `ditto_cfg/` and `ditto_pytorch/`; both TRT cfgs exist but point at engines that don't; `tensorrt` is not installed in `~/venv-ditto`. So it's a 4.6 GB download plus an install, not a config flip.

Three structural reasons a naive switch loses your existing wins:
- `warp_network.py:23` — `if self.model_type != "pytorch" or len(triples) == 1: return [self(*t) for t in triples]`, identical guard at `decoder.py:21`. Under TRT your batching **silently degrades to a per-frame loop**, and the shipped ONNX has batch hard-coded to 1 anyway.
- The CFG batching win lives in PyTorch source (`model.py:338-365`) and would be frozen out by whatever the upstream export traced.
- `core/utils/tensorrt_utils.py` re-`cudaMalloc`s per call and does synchronous `cudaMemcpy` per input/output — strictly worse serialization than today. It also does `from cuda import cuda, cudart, nvrtc`, a layout **removed in cuda-python 13.0.0**; we have 13.3.1, so the wrapper cannot even import without a patch.

**The silent-quality risk is the real reason to be careful:** the `grid_sample_3d` TRT plugin is documented as non-deterministic under GPU contention, producing melting/black-rectangle artifacts that vanish when the GPU idles. We run concurrent sessions on one card. **A melting fox passes every one of your 14 checks** — `identical_frame_ratio` reads 0.000, the CRC check only catches *duplicate* frames not *corrupted* ones, and `mouth_openness_std` would likely go *up*. Only re-exporting ONNX from your patched modules with dynamic batch keeps the wins — 1–2 weeks of real ML engineering.

---

# Where the answer is genuinely "nothing left"

- **Output resolution.** No knob. 512 is fixed in the crop (`source2info.py:93`) and the decoder head; everything expensive already runs at ≤256².
- **Alternative audio encoder.** `Wav2Feat.__init__` (`wav2feat.py:22-29`) raises `ValueError` for anything but hubert; the wavlm branches are unreachable dead code and no wavlm weight exists locally. `audio_feat_dim=1103` is structural. A different encoder means retraining.
- **The offline pipeline.** Differs in exactly one worker; its render workers are the *unpatched* per-frame versions you already replaced. Nothing to harvest.
- **Lower output fps.** Model is 25 fps only; changing it desynchronizes lips.
- **`seq_frames` < 80.** Only `null_cond_embed` (`model.py:286`, verified `(1,80,512)`) is length-bound and rotary is length-agnostic, so slicing it would *run* — but it was trained at 80, and you already see drift at overlap 65. Speculative; don't.
- **Bigger warp/decode batches, `DITTO_STEPS` 8/9/10, `torch.compile`, `cudnn.benchmark`.** Settled. Leave them.

---

# Suggested order, and one methodological correction

1. **CUDA Graphs** (#1) — biggest gain, and the only big one that cannot change a pixel by construction.
2. **Cond-block hoist** (#2) — ~15%, verifiable near-exact with a harness you already have.
3. **Batch the stitch network** (#4a) — 2 hours, removes 22 stream drains/second.
4. **`inference_mode` + `setswitchinterval` + TF32** (#5, #6) — three one-liners, bundle them.
5. Re-measure the ceiling, *then* decide between `eta=0` (#3) and per-stage streams (#4b).

**The correction:** grade every one of these on **`PROBE_OVERLAP` headroom — can 65 or 70 sustain 25 fps? — not on fps at overlap 60.** Production is fed at realtime, so throughput wins are invisible there by construction (README:64-68); they only ever cash out as permission to lower `FOX_OVERLAP`, i.e. reply latency. Measuring at 60 is how the `DITTO_STEPS` question got answered at the wrong operating point.

**And the blind spot to hold in mind throughout:** `rate_probe.py` feeds `np.zeros` silence (line 40) and counts `frames_written` (line 28) — **it never inspects a pixel**, so it cannot see any visual regression whatsoever. Of the gate's 14 checks only three touch pixels, and their limits are `identical_frame_ratio ≤ 0.10` (which README:122-123 records as unable to see the `DITTO_STEPS=3` freeze), `mouth_openness_std ≥ 4.0` (a **floor**, so added motion noise scores *better*), and the CRC duplicate check (catches repeated frames, not wrong ones). Nothing you own measures geometry, identity, artifacts, or lip-sync phase. Levers #3, #9 and #11 all fail inside that gap — for those, watch the mp4.