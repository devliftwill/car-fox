/**
 * Custom photo-avatar persistence — the uploaded face lives entirely in the
 * visitor's browser (localStorage), never on a server.
 *
 * All rig coordinates are normalized (0..1) against the stored image size so
 * the same config renders correctly at any display scale.
 */

export type AvatarRig = {
  /** Mouth center, width (fraction of image width), and roll angle (radians). */
  mouth: { x: number; y: number; w: number; angle: number };
  eyeL: { x: number; y: number; r: number };
  eyeR: { x: number; y: number; r: number };
};

export type AvatarConfig = {
  image: string; // data URL, downscaled
  w: number;
  h: number;
  rig: AvatarRig;
  createdAt: number;
};

const KEY = "carfox.avatar.v1";
export const AVATAR_EVENT = "carfox:avatar-changed";

export function loadAvatar(): AvatarConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as AvatarConfig;
    if (!cfg.image || !cfg.rig?.mouth) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveAvatar(cfg: AvatarConfig) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
  window.dispatchEvent(new Event(AVATAR_EVENT));
}

export function clearAvatar() {
  localStorage.removeItem(KEY);
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
