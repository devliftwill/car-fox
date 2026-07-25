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
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setNames(readNames()), []);

  const refresh = useCallback(async () => {
    const j = await fetch("/api/neural/avatar?list=1").then((r) => r.json()).catch(() => null);
    if (j?.avatars) setLibrary((j.avatars as LibraryAvatar[]).filter(isDitto));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(file: File) {
    setErr(null);
    setBusy(true);
    const avatarId = "chr_" + Date.now().toString(36);
    try {
      const fd = new FormData();
      fd.append("avatar_id", avatarId);
      fd.append("photo", file, file.name || "source.png");
      const r = await fetch("/api/neural/avatar", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j?.code !== undefined && j.code !== 0)) {
        throw new Error(j?.msg || j?.error || `upload failed (${r.status})`);
      }
      const label = (file.name || "").replace(/\.[^.]+$/, "").slice(0, 24) || "New avatar";
      const next = { ...readNames(), [avatarId]: label };
      localStorage.setItem(NAMES_KEY, JSON.stringify(next));
      setNames(next);
      setLibrary((l) => [{ avatar_id: avatarId, engine: "ditto" }, ...l]);
      onPick(avatarId); // switch the call straight to the new face
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
            <button
              key={a.avatar_id}
              onClick={() => onPick(a.avatar_id)}
              onDoubleClick={() => rename(a.avatar_id)}
              title={`${names[a.avatar_id] ?? a.avatar_id} — click to use, double-click to rename`}
              className={`flex flex-col items-center gap-1 rounded-lg p-1 transition ${
                active ? "bg-white/15 ring-1 ring-white/50" : "hover:bg-white/10"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/neural/avatar?thumb=${encodeURIComponent(a.avatar_id)}`}
                alt={names[a.avatar_id] ?? a.avatar_id}
                width={44}
                height={44}
                className="h-11 w-11 rounded-full object-cover"
              />
              <span className="max-w-[64px] truncate text-[10px] text-neutral-400">
                {names[a.avatar_id] ?? (a.avatar_id === "fox_ditto" ? "Car Fox" : a.avatar_id)}
              </span>
            </button>
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
      </div>
      <p className="mt-2 text-center text-[11px] text-neutral-600">
        {busy
          ? "Building the avatar on the GPU…"
          : "Click a face to switch · ＋ adds a photo · double-click to rename"}
      </p>
      {err && <p className="mt-1 text-center text-[11px] text-red-400">{err}</p>}
    </div>
  );
}
