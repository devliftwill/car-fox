"use client";

/**
 * FoxAvatarPicker — pick, upload and reuse self-hosted avatars.
 *
 * A photo becomes a Ditto avatar on the GPU box instantly (no generation
 * wait): POST /api/neural/avatar {photo, avatar_id}. The avatars live on the
 * GPU's disk, so the library survives restarts; friendly names are kept in
 * localStorage so a demo set can be labelled ("Will", "Fox", …) and reused.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type LibraryAvatar = { avatar_id: string; engine?: string; created?: number };

const NAMES_KEY = "carfox.avatarNames";
const readNames = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}");
  } catch {
    return {};
  }
};

/** Avatars the self-hosted (Ditto) engine can drive: photo avatars + the fox. */
const isDitto = (a: LibraryAvatar) =>
  a.engine === "ditto" || a.avatar_id === "fox_ditto" || a.avatar_id.startsWith("chr_");

export default function FoxAvatarPicker({
  current,
  onPick,
}: {
  current: string;
  onPick: (avatarId: string) => void;
}) {
  const [library, setLibrary] = useState<LibraryAvatar[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  // Bumped after an upload so the <img> refetches — the thumb route sets
  // max-age=86400, so a re-recorded face would otherwise show the old frame.
  const [thumbV, setThumbV] = useState(0);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setNames(readNames()), []);

  const refresh = useCallback(async () => {
    const j = await fetch("/api/neural/avatar?list=1").then((r) => r.json()).catch(() => null);
    if (j?.avatars) setLibrary((j.avatars as LibraryAvatar[]).filter(isDitto));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** A photo becomes a still avatar; a VIDEO becomes a moving one — Ditto
   *  animates the face on each source frame and mirror-loops the clip, so the
   *  body keeps breathing between utterances. Measured: same 25fps and same
   *  latency as a still, so the motion is free. */
  async function upload(file: File, kind: "photo" | "video" = "photo") {
    setErr(null);
    setBusy(true);
    const avatarId = "chr_" + Date.now().toString(36);
    try {
      const fd = new FormData();
      fd.append("avatar_id", avatarId);
      if (kind === "video") {
        // engine=ditto routes to "the clip IS the source" rather than to a
        // MuseTalk generation task.
        fd.append("engine", "ditto");
        fd.append("video", file, file.name || "source.webm");
      } else {
        fd.append("photo", file, file.name || "source.png");
      }
      const r = await fetch("/api/neural/avatar", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j?.code !== undefined && j.code !== 0)) {
        throw new Error(j?.msg || j?.error || `upload failed (${r.status})`);
      }
      const label =
        (file.name || "").replace(/\.[^.]+$/, "").slice(0, 24) ||
        (kind === "video" ? "Recorded" : "New avatar");
      const next = { ...readNames(), [avatarId]: label };
      localStorage.setItem(NAMES_KEY, JSON.stringify(next));
      setNames(next);
      setLibrary((l) => [{ avatar_id: avatarId, engine: "ditto" }, ...l]);
      setThumbV((v) => v + 1);
      onPick(avatarId); // switch the call straight to the new face
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Record a short clip from the webcam and make it the avatar source.
   *  Kept to RECORD_MS: every source frame is registered at setup, so a long
   *  clip only slows the wake — the mirror loop makes a few seconds read as
   *  continuous. Sit still-ish: big zooms or shaky motion break the face
   *  detector and the engine fails at setup. */
  const RECORD_MS = 4000;
  async function record() {
    setErr(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 640, facingMode: "user" },
        audio: false, // the source clip drives the FACE only; voice is Gemini's
      });
      const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      // Show the visitor what is being captured — without this you record
      // four seconds blind and only find out afterwards that you were off
      // frame, which is exactly when the face detector fails.
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        void previewRef.current.play().catch(() => {});
      }
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((res) => (rec.onstop = () => res()));
      rec.start();
      setCountdown(Math.round(RECORD_MS / 1000));
      const tick = setInterval(
        () => setCountdown((c) => (c === null ? null : Math.max(0, c - 1))),
        1000,
      );
      await new Promise((r) => setTimeout(r, RECORD_MS));
      clearInterval(tick);
      rec.stop();
      await done;
      setCountdown(null);
      const ext = (mime || "").includes("mp4") ? "mp4" : "webm";
      await upload(new File(chunks, `recorded.${ext}`, { type: mime || "video/webm" }), "video");
    } catch (e) {
      setCountdown(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      stream?.getTracks().forEach((t) => t.stop()); // release the camera light
      if (previewRef.current) previewRef.current.srcObject = null;
    }
  }

  async function remove(avatarId: string) {
    if (!confirm(`Remove "${names[avatarId] ?? avatarId}" from the library?`)) return;
    setErr(null);
    try {
      const r = await fetch(`/api/neural/avatar?avatar_id=${encodeURIComponent(avatarId)}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `remove failed (${r.status})`);
      setLibrary((l) => l.filter((a) => a.avatar_id !== avatarId));
      const next = { ...readNames() };
      delete next[avatarId];
      localStorage.setItem(NAMES_KEY, JSON.stringify(next));
      setNames(next);
      // If the removed face was on the call, fall back to the built-in fox.
      if (current === avatarId) onPick("fox_ditto");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function rename(avatarId: string) {
    const label = prompt("Name this avatar (for the demo library)", names[avatarId] ?? "");
    if (label === null) return;
    const next = { ...readNames(), [avatarId]: label.slice(0, 24) };
    localStorage.setItem(NAMES_KEY, JSON.stringify(next));
    setNames(next);
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {library.map((a) => {
          const active = a.avatar_id === current;
          return (
            <div key={a.avatar_id} className="group relative">
            <button
              onClick={() => onPick(a.avatar_id)}
              onDoubleClick={() => rename(a.avatar_id)}
              title={`${names[a.avatar_id] ?? a.avatar_id} — click to use, double-click to rename`}
              className={`flex flex-col items-center gap-1 rounded-lg p-1 transition ${
                active ? "bg-white/15 ring-1 ring-white/50" : "hover:bg-white/10"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/neural/avatar?thumb=${encodeURIComponent(a.avatar_id)}&v=${thumbV}`}
                alt={names[a.avatar_id] ?? a.avatar_id}
                width={44}
                height={44}
                className="h-11 w-11 rounded-full object-cover"
              />
              <span className="max-w-[64px] truncate text-[10px] text-neutral-400">
                {names[a.avatar_id] ?? (a.avatar_id === "fox_ditto" ? "Car Fox" : a.avatar_id)}
              </span>
            </button>
            {a.avatar_id !== "fox_ditto" && (
              <button
                onClick={() => void remove(a.avatar_id)}
                aria-label={`Remove ${names[a.avatar_id] ?? a.avatar_id}`}
                title="Remove from library"
                className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[11px] leading-none text-neutral-300 ring-1 ring-neutral-600 hover:bg-red-900 hover:text-white group-hover:flex"
              >
                ×
              </button>
            )}
            </div>
          );
        })}

        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-neutral-600 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200 disabled:opacity-50"
          title="Upload a photo to create a new avatar"
        >
          {busy ? "…" : "＋"}
        </button>
        {/* Record a clip — a MOVING source, so the body keeps breathing
            between utterances instead of being a frozen photo. */}
        <button
          onClick={() => void record()}
          disabled={busy || countdown !== null}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-red-700/70 text-red-400 hover:border-red-500 hover:text-red-300 disabled:opacity-50"
          title="Record 4s from your camera — the clip becomes a moving avatar"
        >
          {countdown !== null ? countdown : "●"}
        </button>

        {/* Same thing from an existing file, for anyone who would rather
            supply real footage than sit for the camera. */}
        <button
          onClick={() => videoRef.current?.click()}
          disabled={busy || countdown !== null}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-neutral-600 text-[10px] text-neutral-400 hover:border-neutral-400 hover:text-neutral-200 disabled:opacity-50"
          title="Upload a short video (2-5s) as a moving avatar"
        >
          MP4
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <input
          ref={videoRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f, "video");
            e.target.value = "";
          }}
        />
      </div>
      {countdown !== null && (
        <div className="mt-3 flex justify-center">
          <div className="relative">
            <video
              ref={previewRef}
              muted
              playsInline
              className="h-32 w-32 rounded-lg object-cover ring-2 ring-red-600"
            />
            <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 text-[11px] text-red-400">
              ● {countdown}s
            </span>
          </div>
        </div>
      )}
      <p className="mt-2 text-center text-[11px] text-neutral-600">
        {countdown !== null
          ? `Recording… ${countdown}s — sit still, keep your face in frame`
          : busy
            ? "Building the avatar on the GPU…"
            : "Click a face to switch · ＋ photo · ● record 4s · MP4 file · double-click to rename"}
      </p>
      {err && <p className="mt-1 text-center text-[11px] text-red-400">{err}</p>}
    </div>
  );
}
