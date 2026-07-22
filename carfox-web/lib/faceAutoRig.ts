/**
 * Face auto-rigging via MediaPipe Face Landmarker — fully local (wasm + model
 * vendored under /public/mediapipe, ~15MB, cached hard).
 *
 * Produces normalized rig pins + lip/eye contours, or null when no face is
 * found (cartoon mascots, pets, cars…) — callers fall back to manual pins.
 */
import type { AvatarRig } from "./avatarStore";

// Canonical FaceMesh indices.
const MOUTH_L = 61;
const MOUTH_R = 291;
const EYE_L_OUTER = 33;
const EYE_L_INNER = 133;
const EYE_R_INNER = 362;
const EYE_R_OUTER = 263;
// Inner-lip ring, canonical order: left corner → bottom arc → right corner → top arc.
const LIP_INNER_BOTTOM = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
const LIP_INNER_TOP = [308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78];
const EYE_L_RING = [33, 160, 158, 133, 153, 144];
const EYE_R_RING = [362, 385, 387, 263, 373, 380];

type Pt = { x: number; y: number };
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * `W`/`H` are pixel dimensions of the analyzed frame — landmark coords are
 * normalized per-axis, so widths and angles must be computed in pixel space
 * or non-square sources get skewed rigs.
 */
function rigFromLandmarks(lm: Pt[] | undefined, W: number, H: number): AvatarRig | null {
  if (!lm) return null;
  const p = (i: number): Pt => ({ x: lm[i].x * W, y: lm[i].y * H }); // → pixels
  const mouthL = p(MOUTH_L);
  const mouthR = p(MOUTH_R);
  const mouthC = mid(mouthL, mouthR);
  const eyeL = mid(p(EYE_L_OUTER), p(EYE_L_INNER));
  const eyeR = mid(p(EYE_R_INNER), p(EYE_R_OUTER));
  const eyeSpan = dist(eyeL, eyeR);
  const norm = (pt: Pt) => ({ x: pt.x / W, y: pt.y / H });
  return {
    mouth: {
      x: mouthC.x / W,
      y: mouthC.y / H,
      w: (dist(mouthL, mouthR) * 1.45) / W, // warp region a bit wider than the lip line
      angle: Math.atan2(mouthR.y - mouthL.y, mouthR.x - mouthL.x),
    },
    eyeL: { x: eyeL.x / W, y: eyeL.y / H, r: (eyeSpan * 0.17) / W },
    eyeR: { x: eyeR.x / W, y: eyeR.y / H, r: (eyeSpan * 0.17) / W },
    contours: {
      lipInnerBottom: LIP_INNER_BOTTOM.map((i) => norm(p(i))),
      lipInnerTop: LIP_INNER_TOP.map((i) => norm(p(i))),
      eyeL: EYE_L_RING.map((i) => norm(p(i))),
      eyeR: EYE_R_RING.map((i) => norm(p(i))),
    },
  };
}

export type FaceRigger = {
  /** Detect a rig on any drawable source at the given pixel dims. */
  rig: (src: HTMLImageElement | HTMLCanvasElement, W: number, H: number) => AvatarRig | null;
  close: () => void;
};

/**
 * Long-lived detector — analyzing a video means hundreds of detections, and
 * model load takes ~a second, so callers keep one of these open.
 */
export async function createFaceRigger(): Promise<FaceRigger> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task" },
    runningMode: "IMAGE",
    numFaces: 1,
  });
  return {
    rig: (src, W, H) => rigFromLandmarks(landmarker.detect(src).faceLandmarks?.[0], W, H),
    close: () => landmarker.close(),
  };
}

/** One-shot convenience (single photo). */
export async function autoRig(img: HTMLImageElement, W: number, H: number): Promise<AvatarRig | null> {
  try {
    const rigger = await createFaceRigger();
    try {
      return rigger.rig(img, W, H);
    } finally {
      rigger.close();
    }
  } catch (e) {
    console.warn("autoRig failed:", e);
    return null;
  }
}
