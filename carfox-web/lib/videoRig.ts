/**
 * videoRig — pre-tracks a short "idle loop" clip so a video avatar needs ZERO
 * runtime ML: at rig time we seek through the clip, detect face landmarks on
 * every frame (MediaPipe, local wasm), smooth the jitter, and store the
 * per-frame rigs. At call time the renderer just looks rigs up by
 * video.currentTime and composites the viseme mouth at the tracked position.
 *
 * This is the same architecture the self-hosted "digital human" stacks use
 * (idle base video + mouth region composite) — with precomputed tracking in
 * place of a GPU.
 */
import { createFaceRigger } from "./faceAutoRig";
import { lerpRig, type AvatarRig, type AvatarVideoTrack, type Pt } from "./avatarStore";

const ANALYZE_FPS = 12;
const MAX_SECONDS = 10;
const MAX_EDGE = 640;

export type VideoAnalysis = {
  track: AvatarVideoTrack;
  w: number; // render canvas dims (≤640, video aspect)
  h: number;
};

export async function analyzeVideo(
  url: string,
  onProgress?: (done: number, total: number) => void
): Promise<VideoAnalysis | null> {
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error("Could not load that video."));
  });
  // MediaRecorder webm quirk: duration reads Infinity until you seek far past
  // the end once — required for the in-lab webcam recordings.
  if (!isFinite(video.duration)) {
    await new Promise<void>((res) => {
      video.onseeked = () => res();
      video.currentTime = 1e9;
      setTimeout(res, 3000);
    });
    video.currentTime = 0;
    await new Promise((r) => setTimeout(r, 100));
  }
  const duration = Math.min(video.duration || 0, MAX_SECONDS);
  if (!duration || !video.videoWidth) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

  const total = Math.max(2, Math.floor(duration * ANALYZE_FPS));
  const rigger = await createFaceRigger();
  const raw: (AvatarRig | null)[] = [];
  try {
    for (let i = 0; i < total; i++) {
      const t = Math.min(duration - 0.001, i / ANALYZE_FPS);
      await new Promise<void>((res, rej) => {
        const bail = setTimeout(() => rej(new Error("seek timeout")), 4000);
        video.onseeked = () => {
          clearTimeout(bail);
          res();
        };
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, w, h);
      raw.push(rigger.rig(canvas, w, h));
      onProgress?.(i + 1, total);
    }
  } catch {
    return null;
  } finally {
    rigger.close();
  }

  // Coverage gate: a face we lose half the time makes a twitchy avatar.
  const found = raw.filter(Boolean).length;
  if (found < total * 0.6) return null;

  // Fill gaps with the nearest previous detection (then leading gaps with the
  // first real one), and EMA-smooth to kill detector jitter.
  const firstReal = raw.find(Boolean)!;
  const frames: AvatarRig[] = [];
  let prev: AvatarRig = firstReal;
  for (const r of raw) {
    const cur = r ?? prev;
    frames.push(frames.length === 0 ? cur : lerpRig(frames[frames.length - 1], cur, 0.55));
    prev = cur;
  }

  return { track: { fps: ANALYZE_FPS, duration, frames }, w, h };
}

/** Rig at time t (seconds into the loop), interpolated between tracked frames. */
export function rigAt(track: AvatarVideoTrack, t: number): AvatarRig {
  const clamped = Math.max(0, Math.min(track.duration - 0.001, t));
  const pos = clamped * track.fps;
  const i = Math.min(track.frames.length - 1, Math.floor(pos));
  const j = Math.min(track.frames.length - 1, i + 1);
  return lerpRig(track.frames[i], track.frames[j], pos - i);
}

/** Rough center-face point for framing hints. */
export function faceCenter(rig: AvatarRig): Pt {
  return {
    x: (rig.eyeL.x + rig.eyeR.x + rig.mouth.x) / 3,
    y: (rig.eyeL.y + rig.eyeR.y + rig.mouth.y) / 3,
  };
}
