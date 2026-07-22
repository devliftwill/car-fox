"use client";

/**
 * Avatar Studio — upload any photo and turn it into the live talking avatar.
 *
 * Flow: upload → face auto-detect (MediaPipe, fully in-browser) → drag the
 * four pins to fine-tune (mouth corners, eyes) → watch it babble in the live
 * preview → "Save & talk" stores it locally and opens the dock, where the
 * REAL Gemini voice call drives this face through the same viseme pipeline
 * as the fox. Nothing is uploaded anywhere: the photo lives in localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import PhotoAvatar from "@/components/PhotoAvatar";
import type { FoxSample } from "@/components/FoxAvatar";
import {
  AVATAR_EVENT,
  clearAvatar,
  defaultRig,
  importImage,
  loadAvatar,
  saveAvatar,
  type AvatarConfig,
  type AvatarRig,
} from "@/lib/avatarStore";
import { autoRig } from "@/lib/faceAutoRig";

type Pin = { x: number; y: number };
type Pins = { mL: Pin; mR: Pin; eL: Pin; eR: Pin };
type Detect = "idle" | "running" | "found" | "none";

/** rig (center/width/angle) → corner+eye pins */
function rigToPins(rig: AvatarRig, W: number, H: number): Pins {
  const halfW = (rig.mouth.w * W) / 2;
  const dx = (Math.cos(rig.mouth.angle) * halfW) / W;
  const dy = (Math.sin(rig.mouth.angle) * halfW) / H;
  return {
    mL: { x: rig.mouth.x - dx, y: rig.mouth.y - dy },
    mR: { x: rig.mouth.x + dx, y: rig.mouth.y + dy },
    eL: { x: rig.eyeL.x, y: rig.eyeL.y },
    eR: { x: rig.eyeR.x, y: rig.eyeR.y },
  };
}

/** corner+eye pins → rig, computed in pixel space so angles stay true */
function pinsToRig(pins: Pins, W: number, H: number): AvatarRig {
  const dxPx = (pins.mR.x - pins.mL.x) * W;
  const dyPx = (pins.mR.y - pins.mL.y) * H;
  const wPx = Math.max(20, Math.hypot(dxPx, dyPx));
  const eyeSpanPx = Math.max(16, Math.hypot((pins.eR.x - pins.eL.x) * W, (pins.eR.y - pins.eL.y) * H));
  const r = (eyeSpanPx * 0.17) / W;
  return {
    mouth: {
      x: (pins.mL.x + pins.mR.x) / 2,
      y: (pins.mL.y + pins.mR.y) / 2,
      w: wPx / W,
      angle: Math.atan2(dyPx, dxPx),
    },
    eyeL: { x: pins.eL.x, y: pins.eL.y, r },
    eyeR: { x: pins.eR.x, y: pins.eR.y, r },
  };
}

const PIN_LABELS: Record<keyof Pins, string> = {
  mL: "mouth left",
  mR: "mouth right",
  eL: "left eye",
  eR: "right eye",
};

/**
 * When the detected face is small (wide shot), zoom in: crop a portrait
 * around the face and remap the rig into crop space. Users upload group
 * photos and full-body shots — a talking speck isn't a good avatar.
 */
async function autoCropToFace(
  dataUrl: string,
  W: number,
  H: number,
  rig: AvatarRig
): Promise<{ img: { dataUrl: string; w: number; h: number }; rig: AvatarRig } | null> {
  if (rig.mouth.w >= 0.13) return null; // face already fills enough of the frame
  const eyeSpanPx = Math.hypot((rig.eyeR.x - rig.eyeL.x) * W, (rig.eyeR.y - rig.eyeL.y) * H);
  const faceCx = ((rig.eyeL.x + rig.eyeR.x) / 2 + rig.mouth.x) / 2 * W;
  const cropW = Math.min(W, Math.max(eyeSpanPx * 4.6, rig.mouth.w * W * 4.4));
  const cropH = Math.min(H, cropW * 1.25);
  const x0 = Math.max(0, Math.min(W - cropW, faceCx - cropW / 2));
  // eyes should land ~42% from the crop top
  const y0 = Math.max(0, Math.min(H - cropH, (rig.eyeL.y + rig.eyeR.y) / 2 * H - cropH * 0.42));
  const img = new Image();
  img.src = dataUrl;
  await new Promise((r) => (img.onload = r));
  const scale = Math.min(1, 640 / Math.max(cropW, cropH));
  const cw = Math.round(cropW * scale);
  const ch = Math.round(cropH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext("2d")!.drawImage(img, x0, y0, cropW, cropH, 0, 0, cw, ch);
  const remap = (p: { x: number; y: number }) => ({
    x: (p.x * W - x0) / cropW,
    y: (p.y * H - y0) / cropH,
  });
  return {
    img: { dataUrl: canvas.toDataURL("image/jpeg", 0.87), w: cw, h: ch },
    rig: {
      mouth: { ...remap(rig.mouth), w: (rig.mouth.w * W) / cropW, angle: rig.mouth.angle },
      eyeL: { ...remap(rig.eyeL), r: (rig.eyeL.r * W) / cropW },
      eyeR: { ...remap(rig.eyeR), r: (rig.eyeR.r * W) / cropW },
    },
  };
}

export default function AvatarStudio() {
  const [img, setImg] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const [pins, setPins] = useState<Pins | null>(null);
  const [detect, setDetect] = useState<Detect>("idle");
  const [talking, setTalking] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<keyof Pins | null>(null);
  const talkingRef = useRef(talking);
  useEffect(() => {
    talkingRef.current = talking;
  });
  // Tracks whether a custom avatar is saved; save/clear dispatch AVATAR_EVENT.
  const hasSaved = useSyncExternalStore(
    (cb) => {
      window.addEventListener(AVATAR_EVENT, cb);
      return () => window.removeEventListener(AVATAR_EVENT, cb);
    },
    () => loadAvatar() !== null,
    () => false
  );

  const rig = useMemo(
    () => (img && pins ? pinsToRig(pins, img.w, img.h) : null),
    [img, pins]
  );
  const cfg: AvatarConfig | null = useMemo(
    () => (img && rig ? { image: img.dataUrl, w: img.w, h: img.h, rig, createdAt: savedAt ?? 0 } : null),
    [img, rig, savedAt]
  );

  // Synthetic "babble" driver for the preview — no mic, no API, just vibes.
  const sample = useCallback((): FoxSample => {
    if (!talkingRef.current) return { mouth: null };
    const t = performance.now() / 1000;
    const syllable = Math.abs(Math.sin(t * 6.1));
    const phrase = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.3));
    const open = Math.min(1, syllable * phrase * 1.1);
    const round = Math.max(0, Math.sin(t * 2.7)) * 0.55;
    return { mouth: { open, round, energy: open * 0.8, speaking: true } };
  }, []);

  const runDetect = useCallback(async (dataUrl: string, w: number, h: number) => {
    setDetect("running");
    const el = new Image();
    el.src = dataUrl;
    await new Promise((r) => (el.onload = r));
    const found = await autoRig(el, w, h);
    if (found) {
      // Wide shot? Zoom to the face and remap the rig.
      const cropped = await autoCropToFace(dataUrl, w, h, found);
      if (cropped) {
        setImg(cropped.img);
        setPins(rigToPins(cropped.rig, cropped.img.w, cropped.img.h));
      } else {
        setPins(rigToPins(found, w, h));
      }
      setDetect("found");
    } else {
      setPins(rigToPins(defaultRig(), w, h));
      setDetect("none");
    }
  }, []);

  const loadFrom = useCallback(
    async (src: Blob | string) => {
      const r = await importImage(src);
      setImg(r);
      setSavedAt(null);
      await runDetect(r.dataUrl, r.w, r.h);
    },
    [runDetect]
  );

  // Dev/test hook: window.__avatarLoadUrl("/carfox-avatar.png")
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__avatarLoadUrl = (url: string) => loadFrom(url);
    return () => {
      delete (window as unknown as Record<string, unknown>).__avatarLoadUrl;
    };
  }, [loadFrom]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void loadFrom(f);
    e.target.value = "";
  }

  function onPointerDown(k: keyof Pins) {
    return (e: React.PointerEvent) => {
      dragging.current = k;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
  }
  function onPointerMove(e: React.PointerEvent) {
    const k = dragging.current;
    const box = boxRef.current;
    if (!k || !box) return;
    const rect = box.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setPins((p) => (p ? { ...p, [k]: { x, y } } : p));
  }
  function onPointerUp() {
    dragging.current = null;
  }

  function save() {
    if (!cfg) return;
    const stamped = { ...cfg, createdAt: Date.now() };
    saveAvatar(stamped);
    setSavedAt(stamped.createdAt);
    // The dock lives on every page — open it right here with the new face.
    window.dispatchEvent(new Event("carfox:open"));
  }

  function resetToFox() {
    clearAvatar();
    setSavedAt(null);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="sq-kicker text-neutral-400">Make it yours</p>
      <h1 className="text-3xl font-light tracking-tight">Avatar Studio</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-neutral-500">
        Upload a photo and it becomes the live talking face on your Car Fox calls — same voice,
        same brain, your face (or your dog&apos;s). Everything stays in your browser; the photo is
        never uploaded to a server.
      </p>

      <div className="mt-10 flex flex-col items-start gap-10 md:flex-row">
        {/* preview + pins */}
        <div className="w-full max-w-[400px]">
          {img && cfg ? (
            <div
              ref={boxRef}
              className="fox-live-frame relative w-full touch-none overflow-hidden rounded-2xl shadow-2xl"
              style={{ aspectRatio: `${img.w} / ${img.h}` }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <PhotoAvatar key={img.dataUrl.length + ":" + img.dataUrl.slice(-32)} config={cfg} sample={sample} className="h-full w-full" />
              {pins &&
                (Object.keys(pins) as (keyof Pins)[]).map((k) => (
                  <button
                    key={k}
                    onPointerDown={onPointerDown(k)}
                    aria-label={`Drag to adjust ${PIN_LABELS[k]}`}
                    title={PIN_LABELS[k]}
                    className={`avatar-pin ${k.startsWith("m") ? "avatar-pin--mouth" : "avatar-pin--eye"}`}
                    style={{ left: `${pins[k].x * 100}%`, top: `${pins[k].y * 100}%` }}
                  />
                ))}
            </div>
          ) : (
            <label
              className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-neutral-300 bg-neutral-50 p-12 text-center hover:border-neutral-500"
              style={{ aspectRatio: "4 / 5" }}
            >
              <span className="text-4xl">📷</span>
              <span className="text-[15px] font-medium">Choose a photo</span>
              <span className="text-[12.5px] text-neutral-500">
                A clear, front-facing head &amp; shoulders shot works best
              </span>
              <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            </label>
          )}
        </div>

        {/* controls */}
        <div className="w-full max-w-[340px] space-y-6">
          {img && (
            <>
              <div className="text-[13.5px] leading-relaxed text-neutral-600">
                {detect === "running" && "Looking for a face…"}
                {detect === "found" &&
                  "Face found — pins placed automatically. Drag them if anything's off: orange pins are the mouth corners, blue pins the eyes."}
                {detect === "none" &&
                  "No face detected (mascots and pets count!) — drag the orange pins to the mouth corners and the blue pins onto the eyes."}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setTalking((v) => !v)} className="sq-btn border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                  {talking ? "Pause preview" : "Preview talking"}
                </button>
                <label className="sq-btn cursor-pointer border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                  Different photo
                  <input type="file" accept="image/*" className="hidden" onChange={onFile} />
                </label>
              </div>
              <button onClick={save} className="sq-btn sq-btn--black w-full">
                {savedAt ? "Saved ✓ — talk to it in the corner" : "Save & talk to it now"}
              </button>
            </>
          )}
          {hasSaved && (
            <button onClick={resetToFox} className="sq-btn w-full border border-neutral-300 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900">
              Remove my photo — back to the fox
            </button>
          )}
          <p className="text-[12px] leading-relaxed text-neutral-400">
            The saved face takes over the Car Fox dock on every page. Face detection runs locally
            (MediaPipe wasm) — works offline, nothing leaves this device.
          </p>
        </div>
      </div>
    </main>
  );
}
