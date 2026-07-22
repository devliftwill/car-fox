# Neural Mouth — self-hosted, no avatar vendors

The from-scratch upgrade path for the Avatar Lab: replace the client-side warp
mouth with a **neural lip-sync composite** (MuseTalk served by LiveTalking) on
a GPU VM **we own**. Same architecture class the commercial products use for
the mouth region; zero per-minute vendor fees — only raw GPU compute.

```
browser (Avatar Lab) ── idle base loop (living portrait) ──▶ avatar prep (once)
Gemini Live audio ──▶ GPU server: MuseTalk mouth @30fps ──▶ WebRTC video ──▶ lab panel
```

## Components (all open source, self-hosted)

| Piece | What | License |
| --- | --- | --- |
| [MuseTalk](https://github.com/TMElyralab/MuseTalk) | real-time mouth-region inpainting U-Net (30fps+ on V100/L4-class) | code MIT — **verify current model-weight terms before commercial use** |
| [LiveTalking](https://github.com/lipku/LiveTalking) | WebRTC digital-human server that wraps MuseTalk (also wav2lip/Ultralight) | Apache-2.0 |

## One-time setup (blocked on two user actions)

1. **Re-auth gcloud** (interactive): `gcloud auth login`
2. **GPU quota**: many projects have `GPUS_ALL_REGIONS = 0`. Check / request:

```bash
gcloud compute regions describe us-central1 --project otava-469016 \
  --format='table(quotas.filter("metric:NVIDIA_L4_GPUS OR metric:GPUS_ALL_REGIONS"))'
# if 0 → request increase to 1 in the console (IAM & Admin → Quotas), usually approved in hours
```

3. **Provision** (spot L4, ~$0.22–0.30/hr; stop when idle):

```bash
gcloud compute instances create fox-neural-mouth \
  --project otava-469016 --zone us-central1-a \
  --machine-type g2-standard-4 --provisioning-model SPOT \
  --image-family common-cu121-debian-11 --image-project deeplearning-platform-release \
  --boot-disk-size 100GB \
  --maintenance-policy TERMINATE
```

4. **Install** (on the VM): `bash setup.sh` (this directory) — clones LiveTalking,
   creates the conda env, downloads MuseTalk weights (~10GB).

## Bring-up & verification order

1. **Prove the renderer**: prep an avatar from our generated base loop
   (`carfox-web/public/demo-idle.mp4`) using LiveTalking's avatar-generation
   script for musetalk mode, then run its built-in demo and confirm ≥25fps
   lip-synced video in the browser via WebRTC. No Gemini yet.
2. **Wire our audio**: LiveTalking accepts external audio streams; feed it the
   Gemini Live PCM (same 24k mono the lab already handles) either by moving
   the Gemini session server-side (fox_bot/pipecat pattern minus LemonSlice)
   or by relaying PCM up from the browser over a WebSocket.
   Sync note: delay local audio playback by the measured mouth latency
   (~300–500ms) so lips and sound line up.
3. **Lab toggle**: "Neural mouth (GPU)" vs "Local warp" in /avatar, gated on
   the server's health endpoint — warp remains the zero-cost fallback.

## Cost control

- SPOT instance + `gcloud compute instances stop fox-neural-mouth` when idle.
- Idle-suicide cron on the VM (shut down after N minutes with no session) —
  same discipline as the fox daemon.

## Why not in-browser neural?

WebGPU inference of a wav2lip-class model is possible in research terms but
wildly device-dependent (fails on mobile/integrated GPUs) and well below
MuseTalk quality. A small owned GPU is the reliable "from scratch" answer.

---

## AS BUILT (2026-07-22) — live

- **VM**: `fox-neural-mouth`, us-central1-a, n1-standard-8 + **T4** on-demand
  (~$0.55/hr; L4 had a multi-region stockout the day of the build — re-shop
  `g2-standard-4` later for +40% fps). Public IP **136.113.13.127**.
- **Service**: `fox-neural.service` (systemd, enabled) → LiveTalking
  `app.py --transport webrtc --model wav2lip --avatar_id carfox_customer`.
- **Avatar**: generated on-VM from the lab's Seedance idle clip:
  `python -m avatars.wav2lip.genavatar --video_path ~/demo-idle.mp4 --avatar_id carfox_customer --img_size 256`
  (run from `~/LiveTalking`; don't start the server until `coords.pkl` exists).
- **Web**: /avatar → "Neural GPU mouth" checkbox; relays at `/api/neural/*`
  (env `FOX_NEURAL_URL`, falls back to the IP above).
- **Start/stop** (billing): `gcloud compute instances start|stop fox-neural-mouth --zone us-central1-a`
  — the lab falls back to local avatars whenever it's stopped.
- **Next quality step**: MuseTalk mode (better mouth region than wav2lip256)
  per the plan above; weights + `--model musetalk` on the same box.
