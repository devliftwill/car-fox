/**
 * Custom photo-avatar persistence — the uploaded face lives entirely in the
 * visitor's browser (localStorage), never on a server.
 *
 * All rig coordinates are normalized (0..1) against the stored image size so
 * the same config renders correctly at any display scale.
 */

export type Pt = { x: number; y: number };

export type AvatarRig = {
  /** Mouth center, width (fraction of image width), and roll angle (radians). */
  mouth: { x: number; y: number; w: number; angle: number };
  eyeL: { x: number; y: number; r: number };
  eyeR: { x: number; y: number; r: number };
  /**
   * Detected face contours (normalized) — present when MediaPipe found the
   * face. They let the renderer warp the photo's own lips/eyelids instead of
   * approximating; manual rigs go without and use synthesized shapes.
   */
  contours?: {
    lipInnerTop: Pt[]; // right corner → top arc → left corner
    lipInnerBottom: Pt[]; // left corner → bottom arc → right corner
    eyeL: Pt[]; // 6-pt ring
    eyeR: Pt[];
  };
};

/** Pre-tracked motion for a video-based avatar: frames[i] is the rig at i/fps. */
export type AvatarVideoTrack = {
  fps: number;
  duration: number; // seconds of the analyzed loop
  frames: AvatarRig[];
};

export type AvatarConfig = {
  /** "photo" (default, legacy) or "video" (living-portrait loop). */
  mode?: "photo" | "video";
  image?: string; // photo mode: data URL, downscaled
  video?: AvatarVideoTrack; // video mode: tracking data (blob lives in IndexedDB)
  /** Transient object URL for the video blob — set at load/save, never persisted. */
  videoUrl?: string;
  w: number;
  h: number;
  rig: AvatarRig; // photo rig, or the first tracked frame for video
  createdAt: number;
};

/** Linear interpolation between two tracked rigs (same contour topology). */
export function lerpRig(a: AvatarRig, b: AvatarRig, t: number): AvatarRig {
  const L = (x: number, y: number) => x + (y - x) * t;
  const lp = (p: Pt, q: Pt): Pt => ({ x: L(p.x, q.x), y: L(p.y, q.y) });
  return {
    mouth: {
      x: L(a.mouth.x, b.mouth.x),
      y: L(a.mouth.y, b.mouth.y),
      w: L(a.mouth.w, b.mouth.w),
      angle: L(a.mouth.angle, b.mouth.angle),
    },
    eyeL: { x: L(a.eyeL.x, b.eyeL.x), y: L(a.eyeL.y, b.eyeL.y), r: L(a.eyeL.r, b.eyeL.r) },
    eyeR: { x: L(a.eyeR.x, b.eyeR.x), y: L(a.eyeR.y, b.eyeR.y), r: L(a.eyeR.r, b.eyeR.r) },
    contours:
      a.contours && b.contours
        ? {
            lipInnerTop: a.contours.lipInnerTop.map((p, i) => lp(p, b.contours!.lipInnerTop[i])),
            lipInnerBottom: a.contours.lipInnerBottom.map((p, i) => lp(p, b.contours!.lipInnerBottom[i])),
            eyeL: a.contours.eyeL.map((p, i) => lp(p, b.contours!.eyeL[i])),
            eyeR: a.contours.eyeR.map((p, i) => lp(p, b.contours!.eyeR[i])),
          }
        : a.contours,
  };
}

export const AVATAR_EVENT = "carfox:avatar-changed";

// ---- IndexedDB persistence (video blobs are MBs — localStorage can't) ----
const DB_NAME = "carfox-avatar";
const STORE = "avatars";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAvatar(): Promise<AvatarConfig | null> {
  try {
    const rec = await idb<{ cfg: AvatarConfig; videoBlob?: Blob } | undefined>("readonly", (s) => s.get("current"));
    if (!rec?.cfg?.rig?.mouth) return null;
    const cfg = { ...rec.cfg };
    if (cfg.mode === "video" && rec.videoBlob) {
      cfg.videoUrl = URL.createObjectURL(rec.videoBlob);
    } else if (cfg.mode === "video") {
      return null; // tracking data without its video — unusable
    }
    return cfg;
  } catch {
    return null;
  }
}

export async function saveAvatar(cfg: AvatarConfig, videoBlob?: Blob): Promise<void> {
  const { videoUrl: _drop, ...persistable } = cfg; // eslint-disable-line @typescript-eslint/no-unused-vars
  await idb("readwrite", (s) => s.put({ cfg: persistable, videoBlob }, "current"));
  window.dispatchEvent(new Event(AVATAR_EVENT));
}

export async function clearAvatar(): Promise<void> {
  await idb("readwrite", (s) => s.delete("current"));
  window.dispatchEvent(new Event(AVATAR_EVENT));
}

/** Sensible starting pins for a typical head-and-shoulders portrait. */
export function defaultRig(): AvatarRig {
  return {
    mouth: { x: 0.5, y: 0.72, w: 0.3, angle: 0 },
    eyeL: { x: 0.38, y: 0.45, r: 0.05 },
    eyeR: { x: 0.62, y: 0.45, r: 0.05 },
  };
}

/**
 * Load a File/Blob/URL into a downscaled data URL (max 640px long edge).
 * Keeps PNG when the source has transparency, else JPEG for size.
 */
export async function importImage(src: Blob | string): Promise<{ dataUrl: string; w: number; h: number }> {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not load that image."));
      el.src = url;
    });
    const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    // Transparency probe: sample the corners; any alpha < 250 → keep PNG.
    const corners = [
      ctx.getImageData(0, 0, 1, 1),
      ctx.getImageData(w - 1, 0, 1, 1),
      ctx.getImageData(0, h - 1, 1, 1),
      ctx.getImageData(w - 1, h - 1, 1, 1),
    ];
    const hasAlpha = corners.some((c) => c.data[3] < 250);
    const dataUrl = hasAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.87);
    return { dataUrl, w, h };
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}
