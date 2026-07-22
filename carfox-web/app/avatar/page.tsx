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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PhotoAvatar from "@/components/PhotoAvatar";
import VideoAvatar from "@/components/VideoAvatar";
import FoxLiveCall from "@/components/FoxLiveCall";
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
  type Pt,
} from "@/lib/avatarStore";
import { autoRig } from "@/lib/faceAutoRig";
import { analyzeVideo } from "@/lib/videoRig";

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
 * Detected lip/eye contours must follow the pins when the user drags them:
 * similarity-transform each contour from the as-detected rig onto the
 * current one (pixel space — normalized coords skew on non-square images).
 */
function transformContours(base: AvatarRig, cur: AvatarRig, W: number, H: number): AvatarRig["contours"] {
  const ct = base.contours;
  if (!ct) return undefined;
  const k = cur.mouth.w / base.mouth.w;
  const dA = cur.mouth.angle - base.mouth.angle;
  const cos = Math.cos(dA) * k, sin = Math.sin(dA) * k;
  const sCx = base.mouth.x * W, sCy = base.mouth.y * H;
  const dCx = cur.mouth.x * W, dCy = cur.mouth.y * H;
  const mapLip = (p: Pt): Pt => {
    const px = p.x * W - sCx, py = p.y * H - sCy;
    return { x: (dCx + px * cos - py * sin) / W, y: (dCy + px * sin + py * cos) / H };
  };
  const mapEye = (b: { x: number; y: number; r: number }, c: { x: number; y: number; r: number }) => {
    const k2 = c.r / (b.r || 1e-6);
    return (p: Pt): Pt => ({
      x: (c.x * W + (p.x - b.x) * W * k2) / W,
      y: (c.y * H + (p.y - b.y) * H * k2) / H,
    });
  };
  return {
    lipInnerTop: ct.lipInnerTop.map(mapLip),
    lipInnerBottom: ct.lipInnerBottom.map(mapLip),
    eyeL: ct.eyeL.map(mapEye(base.eyeL, cur.eyeL)),
    eyeR: ct.eyeR.map(mapEye(base.eyeR, cur.eyeR)),
  };
}

/**
 * When the detected face is small (wide shot), zoom in: crop a portrait
 * around the face and remap the rig into crop space. Users upload group
 * photos and full-body shots — a talking speck isn't a good avatar.
 *
 * Crops from the ORIGINAL source (native resolution) — cropping the 640px
 * working copy produced blurry postage-stamp avatars.
 */
async function autoCropToFace(
  origSrc: Blob | string,
  rig: AvatarRig
): Promise<{ img: { dataUrl: string; w: number; h: number }; rig: AvatarRig } | null> {
  if (rig.mouth.w >= 0.13) return null; // face already fills enough of the frame
  const url = typeof origSrc === "string" ? origSrc : URL.createObjectURL(origSrc);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("orig load failed"));
    });
  } catch {
    if (typeof origSrc !== "string") URL.revokeObjectURL(url);
    return null;
  }
  const W = img.naturalWidth, H = img.naturalHeight;
  const eyeSpanPx = Math.hypot((rig.eyeR.x - rig.eyeL.x) * W, (rig.eyeR.y - rig.eyeL.y) * H);
  const faceCx = ((rig.eyeL.x + rig.eyeR.x) / 2 + rig.mouth.x) / 2 * W;
  const cropW = Math.min(W, Math.max(eyeSpanPx * 4.6, rig.mouth.w * W * 4.4));
  const cropH = Math.min(H, cropW * 1.25);
  const x0 = Math.max(0, Math.min(W - cropW, faceCx - cropW / 2));
  // eyes should land ~42% from the crop top
  const y0 = Math.max(0, Math.min(H - cropH, (rig.eyeL.y + rig.eyeR.y) / 2 * H - cropH * 0.42));
  const scale = Math.min(1, 640 / Math.max(cropW, cropH));
  const cw = Math.round(cropW * scale);
  const ch = Math.round(cropH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext("2d")!.drawImage(img, x0, y0, cropW, cropH, 0, 0, cw, ch);
  if (typeof origSrc !== "string") URL.revokeObjectURL(url);
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
      contours: rig.contours
        ? {
            lipInnerTop: rig.contours.lipInnerTop.map(remap),
            lipInnerBottom: rig.contours.lipInnerBottom.map(remap),
            eyeL: rig.contours.eyeL.map(remap),
            eyeR: rig.contours.eyeR.map(remap),
          }
        : undefined,
    },
  };
}

export default function AvatarStudio() {
  const [img, setImg] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const [pins, setPins] = useState<Pins | null>(null);
  // As-detected rig (carries lip/eye contours) — pin edits transform from it.
  const [baseRig, setBaseRig] = useState<AvatarRig | null>(null);
  const [detect, setDetect] = useState<Detect>("idle");
  const [talking, setTalking] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Living-portrait draft (video mode) — mutually exclusive with the photo flow.
  const [videoDraft, setVideoDraft] = useState<{ cfg: AvatarConfig; blob: Blob } | null>(null);
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  const [videoErr, setVideoErr] = useState<string | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [neuralMode, setNeuralMode] = useState(false);
  // clip → GPU avatar generation
  const [gpuGen, setGpuGen] = useState<{ taskId: string; progress: number; status: string } | null>(null);
  const [gpuAvatarId, setGpuAvatarId] = useState<string | null>(null);
  useEffect(() => {
    const id = localStorage.getItem("carfox.gpuAvatarId");
    if (id) Promise.resolve().then(() => setGpuAvatarId(id));
  }, []);
  // In-lab webcam recorder (video only, never uploaded anywhere)
  const [recOn, setRecOn] = useState(false);
  const [recSecs, setRecSecs] = useState<number | null>(null);
  const recVideoRef = useRef<HTMLVideoElement | null>(null);
  const recRef = useRef<{ stream?: MediaStream; rec?: MediaRecorder; chunks: Blob[]; timer?: ReturnType<typeof setInterval> }>({ chunks: [] });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<keyof Pins | null>(null);
  const origSrcRef = useRef<Blob | string | null>(null); // full-res source for quality crops
  const talkingRef = useRef(talking);
  useEffect(() => {
    talkingRef.current = talking;
  });
  // Saved-avatar presence (IndexedDB is async; save/clear dispatch AVATAR_EVENT).
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      loadAvatar().then((c) => {
        if (alive) setHasSaved(!!c);
      });
    };
    refresh();
    window.addEventListener(AVATAR_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(AVATAR_EVENT, refresh);
    };
  }, []);

  const rig = useMemo(() => {
    if (!img || !pins) return null;
    const cur = pinsToRig(pins, img.w, img.h);
    if (baseRig?.contours) {
      cur.contours = transformContours(baseRig, cur, img.w, img.h);
    }
    return cur;
  }, [img, pins, baseRig]);
  const cfg: AvatarConfig | null = useMemo(
    () => (img && rig ? { image: img.dataUrl, w: img.w, h: img.h, rig, createdAt: savedAt ?? 0 } : null),
    [img, rig, savedAt]
  );

  // Synthetic "babble" driver for the preview — no mic, no API, just vibes.
  const sample = useCallback((): FoxSample => {
    // QA hook: window.__avatarPose = {open, round} freezes a deterministic pose.
    const pose = (window as unknown as { __avatarPose?: { open: number; round: number } }).__avatarPose;
    if (pose) return { mouth: { open: pose.open, round: pose.round, energy: 0.5, speaking: true } };
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
      // Wide shot? Zoom to the face (from the full-res source) and remap.
      const cropped = await autoCropToFace(origSrcRef.current ?? dataUrl, found);
      if (cropped) {
        setImg(cropped.img);
        setBaseRig(cropped.rig);
        setPins(rigToPins(cropped.rig, cropped.img.w, cropped.img.h));
      } else {
        setBaseRig(found);
        setPins(rigToPins(found, w, h));
      }
      setDetect("found");
    } else {
      setBaseRig(null);
      setPins(rigToPins(defaultRig(), w, h));
      setDetect("none");
    }
  }, []);

  const loadFrom = useCallback(
    async (src: Blob | string) => {
      setVideoDraft(null);
      setVideoErr(null);
      origSrcRef.current = src;
      const r = await importImage(src);
      setImg(r);
      setSavedAt(null);
      await runDetect(r.dataUrl, r.w, r.h);
    },
    [runDetect]
  );

  /** Living portrait: analyze a short idle clip → per-frame tracked rig. */
  const loadFromVideo = useCallback(async (blob: Blob) => {
    setImg(null);
    setPins(null);
    setBaseRig(null);
    setDetect("idle");
    setVideoDraft(null);
    setVideoErr(null);
    setSavedAt(null);
    const url = URL.createObjectURL(blob);
    setAnalyzing({ done: 0, total: 1 });
    const res = await analyzeVideo(url, (done, total) => setAnalyzing({ done, total }));
    setAnalyzing(null);
    if (!res) {
      URL.revokeObjectURL(url);
      setVideoErr(
        "Couldn't track a face through that clip — try a brighter, front-facing video with one person (or use a photo instead)."
      );
      return;
    }
    const cfg: AvatarConfig = {
      mode: "video",
      video: res.track,
      videoUrl: url,
      w: res.w,
      h: res.h,
      rig: res.track.frames[0],
      createdAt: 0,
    };
    setVideoDraft({ cfg, blob });
  }, []);

  // Dev/test hooks: window.__avatarLoadUrl("/x.png"), __avatarLoadVideoUrl("/x.mp4")
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__avatarLoadUrl = (url: string) => loadFrom(url);
    w.__avatarLoadVideoUrl = async (url: string) => {
      const blob = await fetch(url).then((r) => r.blob());
      return loadFromVideo(blob);
    };
    return () => {
      delete w.__avatarLoadUrl;
      delete w.__avatarLoadVideoUrl;
    };
  }, [loadFrom, loadFromVideo]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void (f.type.startsWith("video/") ? loadFromVideo(f) : loadFrom(f));
    e.target.value = "";
  }

  // ---- webcam recorder ----
  async function openRecorder() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      recRef.current.stream = stream;
      setRecOn(true);
    } catch {
      setVideoErr("Camera unavailable — check permissions, or upload a clip instead.");
    }
  }

  function closeRecorder() {
    const r = recRef.current;
    if (r.timer) clearInterval(r.timer);
    if (r.rec && r.rec.state === "recording") {
      r.rec.onstop = null;
      try { r.rec.stop(); } catch {}
    }
    r.stream?.getTracks().forEach((t) => t.stop());
    recRef.current = { chunks: [] };
    setRecOn(false);
    setRecSecs(null);
  }

  function beginRecording() {
    const r = recRef.current;
    if (!r.stream) return;
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
    );
    const rec = new MediaRecorder(r.stream, mime ? { mimeType: mime } : undefined);
    r.rec = rec;
    r.chunks = [];
    rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(r.chunks, { type: rec.mimeType || "video/webm" });
      closeRecorder();
      if (blob.size > 5000) void loadFromVideo(blob);
    };
    rec.start();
    let left = 8;
    setRecSecs(left);
    r.timer = setInterval(() => {
      left -= 1;
      setRecSecs(left);
      if (left <= 0) {
        if (r.timer) clearInterval(r.timer);
        if (rec.state === "recording") rec.stop();
      }
    }, 1000);
  }

  function stopRecordingEarly() {
    const r = recRef.current;
    if (r.timer) clearInterval(r.timer);
    if (r.rec?.state === "recording") r.rec.stop();
  }

  // attach the live camera preview once the panel exists
  useEffect(() => {
    const v = recVideoRef.current;
    const stream = recRef.current.stream;
    if (!recOn || !v || !stream) return;
    v.srcObject = stream;
    v.muted = true;
    v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [recOn]);

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

  async function save() {
    const active = videoDraft?.cfg ?? cfg;
    if (!active) return;
    const stamped = { ...active, createdAt: Date.now() };
    await saveAvatar(stamped, videoDraft?.blob);
    setSavedAt(stamped.createdAt);
    if (videoDraft) setVideoDraft({ ...videoDraft, cfg: stamped });
  }

  /** Ship the current clip to the GPU: it becomes a full MuseTalk avatar. */
  async function generateGpuAvatar() {
    if (!videoDraft) return;
    const avatarId = "lab_" + Date.now().toString(36);
    const fd = new FormData();
    fd.append("avatar_id", avatarId);
    fd.append("video", videoDraft.blob, "clip.webm");
    setGpuGen({ taskId: "", progress: 0, status: "uploading" });
    try {
      const r = await fetch("/api/neural/avatar", { method: "POST", body: fd });
      const j = await r.json();
      const taskId = j?.data?.task_id;
      if (!r.ok || !taskId) throw new Error(j?.msg || j?.error || "task create failed");
      setGpuGen({ taskId, progress: 0, status: "pending" });
      for (;;) {
        await new Promise((res) => setTimeout(res, 5000));
        const s = await fetch(`/api/neural/avatar?task=${taskId}`).then((x) => x.json()).catch(() => null);
        const d = s?.data;
        if (!d) continue;
        setGpuGen({ taskId, progress: d.progress ?? 0, status: d.status ?? "running" });
        if (d.status === "completed") {
          localStorage.setItem("carfox.gpuAvatarId", avatarId);
          setGpuAvatarId(avatarId);
          setGpuGen(null);
          setNeuralMode(true);
          return;
        }
        if (d.status === "failed") throw new Error(d.error_msg || "generation failed");
      }
    } catch (e) {
      setGpuGen(null);
      setVideoErr("GPU avatar generation failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function clearGpuAvatar() {
    localStorage.removeItem("carfox.gpuAvatarId");
    setGpuAvatarId(null);
  }

  async function discardSaved() {
    await clearAvatar();
    setSavedAt(null);
  }

  async function loadSaved() {
    const saved = await loadAvatar();
    if (!saved) return;
    if (saved.mode === "video" && saved.videoUrl) {
      const blob = await fetch(saved.videoUrl).then((r) => r.blob());
      setImg(null);
      setPins(null);
      setBaseRig(null);
      setVideoDraft({ cfg: saved, blob });
      setSavedAt(saved.createdAt);
      setDetect("found");
      return;
    }
    if (!saved.image) return;
    setVideoDraft(null);
    setImg({ dataUrl: saved.image, w: saved.w, h: saved.h });
    setBaseRig(saved.rig.contours ? saved.rig : null);
    setPins(rigToPins(saved.rig, saved.w, saved.h));
    setSavedAt(saved.createdAt);
    setDetect("found");
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="sq-kicker text-neutral-400">Sandbox — experimental</p>
      <h1 className="text-3xl font-light tracking-tight">Avatar Lab</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-neutral-500">
        Turn a photo — or better, a <b>short idle video</b> (5–10s: sit still, blink, breathe) —
        into a live talking avatar, and test-drive it on a real call <b>right here only</b>. The
        Car Fox in the site&apos;s corner dock is not affected by anything in this lab. Media
        stays in your browser; nothing is uploaded to a server.
      </p>

      <div className="mt-10 flex flex-col items-start gap-10 md:flex-row">
        {/* preview + pins */}
        <div className="w-full max-w-[400px]">
          {videoDraft ? (
            <div
              className="fox-live-frame relative w-full overflow-hidden rounded-2xl shadow-2xl"
              style={{ aspectRatio: `${videoDraft.cfg.w} / ${videoDraft.cfg.h}` }}
            >
              <VideoAvatar
                key={videoDraft.cfg.videoUrl}
                config={videoDraft.cfg}
                sample={sample}
                className="h-full w-full"
                debugTag="studio"
              />
            </div>
          ) : img && cfg ? (
            <div
              ref={boxRef}
              className="fox-live-frame relative w-full touch-none overflow-hidden rounded-2xl shadow-2xl"
              style={{ aspectRatio: `${img.w} / ${img.h}` }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <PhotoAvatar key={img.dataUrl.length + ":" + img.dataUrl.slice(-32)} config={cfg} sample={sample} className="h-full w-full" debugTag="studio" />
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
            <div className="w-full space-y-3">
              {recOn ? (
                <div
                  className="relative w-full overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl"
                  style={{ aspectRatio: "4 / 5" }}
                >
                  <video ref={recVideoRef} autoPlay playsInline muted className="h-full w-full object-cover -scale-x-100" />
                  {recSecs !== null && (
                    <div className="absolute left-3 top-3 rounded-md bg-red-600 px-2.5 py-1 text-[13px] font-bold text-white">
                      ● {recSecs}s
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-4">
                    {recSecs === null ? (
                      <>
                        <button onClick={beginRecording} className="sq-btn sq-btn--white">
                          ● Record 8s
                        </button>
                        <button onClick={closeRecorder} className="sq-btn sq-btn--ghost">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button onClick={stopRecordingEarly} className="sq-btn sq-btn--white">
                        ■ Stop
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <label
                  className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-neutral-300 bg-neutral-50 p-12 text-center hover:border-neutral-500"
                  style={{ aspectRatio: "4 / 5" }}
                >
                  <span className="text-4xl">🎬</span>
                  <span className="text-[15px] font-medium">
                    {analyzing
                      ? `Tracking your face… ${analyzing.done}/${analyzing.total}`
                      : "Choose a short video or a photo"}
                  </span>
                  <span className="text-[12.5px] text-neutral-500">
                    Best: a 5–10s front-facing clip where you sit still, blink, and breathe — the
                    avatar inherits its life from your footage. A photo works too.
                  </span>
                  <input type="file" accept="image/*,video/*" className="hidden" onChange={onFile} disabled={!!analyzing} />
                </label>
              )}
              {!recOn && (
                <button
                  onClick={openRecorder}
                  disabled={!!analyzing}
                  className="sq-btn w-full border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900"
                >
                  🎥 Record a short clip with your camera
                </button>
              )}
              {videoErr && <p className="text-[13px] text-red-600">{videoErr}</p>}
              <button
                onClick={async () => {
                  const blob = await fetch("/demo-idle.mp4").then((r) => r.blob());
                  void loadFromVideo(blob);
                }}
                disabled={!!analyzing}
                className="sq-btn w-full border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900"
              >
                Try the demo clip
              </button>
              {hasSaved && (
                <button onClick={loadSaved} className="sq-btn w-full border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                  Load my saved avatar
                </button>
              )}
            </div>
          )}
        </div>

        {/* controls */}
        <div className="w-full max-w-[340px] space-y-6">
          {(img || videoDraft) && (
            <>
              <div className="text-[13.5px] leading-relaxed text-neutral-600">
                {videoDraft &&
                  `Living portrait ready — motion tracked across ${videoDraft.cfg.video?.frames.length} frames. Your own blinks and movement play on loop; the mouth follows the voice.`}
                {!videoDraft && detect === "running" && "Looking for a face…"}
                {!videoDraft && detect === "found" &&
                  "Face found — pins placed automatically. Drag them if anything's off: orange pins are the mouth corners, blue pins the eyes."}
                {!videoDraft && detect === "none" &&
                  "No face detected (mascots and pets count!) — drag the orange pins to the mouth corners and the blue pins onto the eyes."}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setTalking((v) => !v)} className="sq-btn border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                  {talking ? "Pause preview" : "Preview talking"}
                </button>
                <label className="sq-btn cursor-pointer border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                  Different file
                  <input type="file" accept="image/*,video/*" className="hidden" onChange={onFile} />
                </label>
              </div>
              <button onClick={save} className="sq-btn sq-btn--black w-full">
                {savedAt ? "Saved ✓ (this lab only)" : "Save in this lab"}
              </button>
              {videoDraft && !gpuGen && (
                <button onClick={generateGpuAvatar} className="sq-btn w-full border-2 border-neutral-900 font-semibold text-neutral-900">
                  🚀 Put this clip on the GPU face (photoreal)
                </button>
              )}
              {gpuGen && (
                <div className="rounded-lg border border-neutral-200 p-3 text-[13px] text-neutral-600">
                  Building your GPU avatar… {gpuGen.status} {gpuGen.progress ? `${gpuGen.progress}%` : ""}
                  <div className="mt-2 h-[6px] overflow-hidden rounded-full bg-neutral-200">
                    <div className="h-full bg-neutral-900 transition-all" style={{ width: `${gpuGen.progress}%` }} />
                  </div>
                  <div className="mt-1 text-[11.5px] text-neutral-400">Takes 1–3 minutes on the GPU — don&apos;t leave the page.</div>
                </div>
              )}
            </>
          )}
          {gpuAvatarId && !gpuGen && (
            <p className="text-[12.5px] text-neutral-500">
              GPU avatar ready: <b>{gpuAvatarId}</b> — neural calls below use it.{" "}
              <button onClick={clearGpuAvatar} className="underline">reset to default</button>
            </p>
          )}
          {hasSaved && (
            <button onClick={discardSaved} className="sq-btn w-full border border-neutral-300 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900">
              Delete saved avatar
            </button>
          )}
          <p className="text-[12px] leading-relaxed text-neutral-400">
            Face detection runs locally (MediaPipe wasm) — works offline, nothing leaves this
            device. Saved avatars live in this lab only; the corner-dock fox is untouched.
          </p>
        </div>
      </div>

      {/* live test-drive — the ONLY place custom/neural avatars take calls */}
      <section className="mt-16 border-t border-neutral-200 pt-10">
        <p className="sq-kicker text-neutral-400">Test drive</p>
        <h2 className="text-xl font-light tracking-tight">Live call with this avatar</h2>
        <p className="mb-4 mt-1 max-w-xl text-[13.5px] text-neutral-500">
          Same Gemini brain and voice as the Car Fox — your uploaded face, the neural GPU face,
          or the fox if neither is loaded. Only on this page.
        </p>
          <label className="mb-6 flex max-w-xl items-start gap-2.5 text-[13.5px] text-neutral-600">
            <input
              type="checkbox"
              checked={neuralMode}
              onChange={(e) => setNeuralMode(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <b>Neural GPU mouth</b> — render on our self-hosted lip-sync server (photoreal,
              needs the fox-neural-mouth VM running). Voice and lips arrive already synced;
              falls back to the local avatar if the server is offline.
            </span>
          </label>
          <FoxLiveCall
            key={(videoDraft ? videoDraft.cfg.videoUrl : img?.dataUrl.length) + ":" + neuralMode + ":" + (gpuAvatarId ?? "")}
            avatar={videoDraft?.cfg ?? cfg ?? undefined}
            neural={neuralMode}
            neuralAvatarId={gpuAvatarId ?? undefined}
          />
      </section>
    </main>
  );
}
