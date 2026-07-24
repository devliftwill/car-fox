"use client";

/**
 * Avatar Lab — ONE flow, GPU-only (per Will, 2026-07-22):
 *
 *   1. Record 8 seconds with your camera (or upload a short clip)
 *   2. The GPU builds your photoreal MuseTalk avatar (~1–3 min)
 *   3. Talk to it — the Car Fox brain and voice through YOUR face
 *
 * No local warp renderers on this page anymore — neural or nothing.
 * The clip goes browser → our /api/neural/avatar relay → the GPU VM.
 */
import { useEffect, useRef, useState } from "react";
import FoxLiveCall from "@/components/FoxLiveCall";
import FoxDailyCall from "@/components/FoxDailyCall";

type GpuGen = { taskId: string; progress: number; status: string };

export default function AvatarLab() {
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [gpuGen, setGpuGen] = useState<GpuGen | null>(null);
  const [gpuAvatarId, setGpuAvatarId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // library-first: returning users pick a saved avatar; recording is opt-in
  const [wantNew, setWantNew] = useState(false);
  // webcam recorder
  const [recOn, setRecOn] = useState(false);
  const [recSecs, setRecSecs] = useState<number | null>(null);
  const recVideoRef = useRef<HTMLVideoElement | null>(null);
  const clipVideoRef = useRef<HTMLVideoElement | null>(null);
  const recRef = useRef<{ stream?: MediaStream; rec?: MediaRecorder; chunks: Blob[]; timer?: ReturnType<typeof setInterval> }>({ chunks: [] });

  const [library, setLibrary] = useState<{ avatar_id: string; created: number; engine?: string }[]>([]);
  const [gpuEngine, setGpuEngine] = useState<string>("muse");
  // Self-waking studio: the page wakes the GPU VM and waits until it answers.
  const [studio, setStudio] = useState<"checking" | "waking" | "ready" | "error">("checking");

  useEffect(() => {
    const id = localStorage.getItem("carfox.gpuAvatarId");
    const eng = localStorage.getItem("carfox.gpuAvatarEngine") ?? "muse";
    if (id) Promise.resolve().then(() => { setGpuAvatarId(id); setGpuEngine(eng); });
  }, []);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = async () => {
      const j = await fetch("/api/neural/wake").then((r) => r.json()).catch(() => null);
      if (!alive) return;
      if (j?.status === "ready") {
        setStudio("ready");
        fetch("/api/neural/avatar?list=1")
          .then((r) => r.json())
          .then((x) => alive && setLibrary(x?.avatars ?? []))
          .catch(() => {});
        return;
      }
      if (!j || j.status === "error" || ++tries > 40) {
        setStudio("error");
        return;
      }
      setStudio("waking");
      setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, []);

  function pickAvatar(id: string, engine = "muse") {
    localStorage.setItem("carfox.gpuAvatarId", id);
    localStorage.setItem("carfox.gpuAvatarEngine", engine);
    setGpuAvatarId(id);
    setGpuEngine(engine);
  }

  /** Characters: one photo in, ditto avatar out — no GPU generation wait. */
  async function uploadCharacter(file: File) {
    setErr(null);
    const avatarId = "chr_" + Date.now().toString(36);
    const fd = new FormData();
    fd.append("avatar_id", avatarId);
    fd.append("photo", file, file.name || "source.png");
    try {
      const r = await fetch("/api/neural/avatar", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || j?.code !== 0) throw new Error(j?.msg || j?.error || "photo upload failed");
      setLibrary((l) => [{ avatar_id: avatarId, created: Date.now() / 1000, engine: "ditto" }, ...l]);
      pickAvatar(avatarId, "ditto");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Ship a clip to the GPU; it becomes the MuseTalk avatar for calls here. */
  async function generate(blob: Blob) {
    setErr(null);
    const avatarId = "lab_" + Date.now().toString(36);
    const fd = new FormData();
    fd.append("avatar_id", avatarId);
    fd.append("video", blob, "clip.webm");
    setGpuGen({ taskId: "", progress: 0, status: "uploading" });
    try {
      const r = await fetch("/api/neural/avatar", { method: "POST", body: fd });
      const j = await r.json();
      const taskId = j?.data?.task_id;
      if (!r.ok || !taskId) throw new Error(j?.msg || j?.error || "GPU server unreachable — is the VM running?");
      setGpuGen({ taskId, progress: 5, status: "queued" });
      let missing = 0;
      const deadline = Date.now() + 8 * 60 * 1000;
      for (;;) {
        await new Promise((res) => setTimeout(res, 4000));
        if (Date.now() > deadline) throw new Error("generation took too long — the GPU may be overloaded; try again");
        const s = await fetch(`/api/neural/avatar?task=${taskId}`).then((x) => x.json()).catch(() => null);
        const d = s?.data;
        if (!d) {
          // Task unknown = the studio restarted mid-generation; don't spin forever.
          if (++missing >= 4) throw new Error("the studio restarted mid-generation — please record again");
          continue;
        }
        missing = 0;
        setGpuGen({ taskId, progress: Math.max(5, d.progress ?? 0), status: d.status ?? "running" });
        if (d.status === "completed") {
          localStorage.setItem("carfox.gpuAvatarId", avatarId);
          setGpuAvatarId(avatarId);
          setGpuGen(null);
          setLibrary((l) => [{ avatar_id: avatarId, created: Date.now() / 1000 }, ...l]);
          return;
        }
        if (d.status === "failed") throw new Error(d.error_msg || "generation failed");
      }
    } catch (e) {
      setGpuGen(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function acceptClip(blob: Blob) {
    // sanity: readable, 2–20s
    const url = URL.createObjectURL(blob);
    const probe = document.createElement("video");
    probe.src = url;
    probe.muted = true;
    const ok = await new Promise<boolean>((res) => {
      probe.onloadedmetadata = () => res(true);
      probe.onerror = () => res(false);
      setTimeout(() => res(false), 5000);
    });
    if (!ok) {
      URL.revokeObjectURL(url);
      setErr("Couldn't read that video — try a different file.");
      return;
    }
    let dur = probe.duration;
    if (!isFinite(dur)) {
      await new Promise<void>((res) => {
        probe.onseeked = () => res();
        probe.currentTime = 1e9;
        setTimeout(res, 3000);
      });
      dur = probe.duration;
    }
    if (isFinite(dur) && dur > 20) {
      URL.revokeObjectURL(url);
      setErr("Keep the clip under 20 seconds — short and steady works best.");
      return;
    }
    if (clip) URL.revokeObjectURL(clip.url);
    setClip({ blob, url });
    void generate(blob);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void acceptClip(f);
    e.target.value = "";
  }

  // Dev/test hook
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__avatarLoadVideoUrl = async (url: string) => {
      const blob = await fetch(url).then((r) => r.blob());
      return acceptClip(blob);
    };
    return () => {
      delete w.__avatarLoadVideoUrl;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip]);

  // ---- webcam recorder ----
  async function openRecorder() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      recRef.current.stream = stream;
      setRecOn(true);
    } catch {
      setErr("Camera unavailable — check browser permissions, or upload a clip instead.");
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
      if (blob.size > 5000) void acceptClip(blob);
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

  // clip thumbnail playback
  useEffect(() => {
    const v = clipVideoRef.current;
    if (!v || !clip) return;
    v.src = clip.url;
    v.muted = true;
    v.loop = true;
    v.play().catch(() => {});
  }, [clip]);

  function recordNew() {
    // keep the library — just go back to step 1
    setGpuAvatarId(null);
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
  }

  const busy = !!gpuGen;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="sq-kicker text-neutral-400">Sandbox — experimental</p>
      <h1 className="text-3xl font-light tracking-tight">Avatar Lab</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-neutral-500">
        Record eight seconds of yourself (or upload a short clip) and the GPU turns it into a
        photoreal talking avatar — the Car Fox brain and voice, your face. Only on this page;
        the corner-dock fox is untouched.
      </p>

      {/* Studio state gate — the GPU wakes itself when you arrive */}
      {studio !== "ready" && (
        <section className="mx-auto mt-12 w-full max-w-[420px] rounded-2xl border border-neutral-200 p-8 text-center">
          {studio === "checking" && <p className="text-[14px] text-neutral-500">Checking the studio…</p>}
          {studio === "waking" && (
            <>
              <p className="text-[15px] font-medium">Warming up the studio…</p>
              <p className="mt-1 text-[13px] text-neutral-500">
                The GPU wakes on demand — about 90 seconds. This page will continue automatically.
              </p>
              <div className="mt-4 h-[6px] overflow-hidden rounded-full bg-neutral-200">
                <div className="fox-warming-bar h-full w-1/3 rounded-full bg-neutral-900" />
              </div>
            </>
          )}
          {studio === "error" && (
            <>
              <p className="text-[14.5px] font-medium text-red-600">The studio didn&apos;t come up.</p>
              <button onClick={() => window.location.reload()} className="sq-btn sq-btn--black mt-4">
                Try again
              </button>
            </>
          )}
        </section>
      )}

      {/* Step 1 — pick a saved avatar, or get a clip */}
      {studio === "ready" && !gpuAvatarId && !busy && (
        <section className="mt-10">
          {library.length > 0 && !wantNew && !recOn ? (
            <div className="mx-auto w-full max-w-[460px]">
              <p className="mb-4 text-center text-[14.5px] font-medium">Welcome back — pick your avatar:</p>
              <div className="flex flex-wrap justify-center gap-3">
                {library.map((a) => (
                  <button
                    key={a.avatar_id}
                    onClick={() => pickAvatar(a.avatar_id, a.engine ?? "muse")}
                    className="group w-[124px] overflow-hidden rounded-xl border border-neutral-200 text-left shadow-sm hover:border-neutral-900 hover:shadow-md"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/neural/avatar?thumb=${encodeURIComponent(a.avatar_id)}`} alt="" className="aspect-square w-full bg-neutral-100 object-cover" />
                    <span className="block truncate px-2 py-1.5 text-[11px] text-neutral-500 group-hover:text-neutral-900">
                      {a.engine === "ditto" ? "🦊 " : ""}{a.avatar_id}
                    </span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setWantNew(true)}
                className="sq-btn mt-6 w-full border border-neutral-300 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900"
              >
                🎥 Record a new avatar instead
              </button>
            </div>
          ) : recOn ? (
            <div className="relative mx-auto w-full max-w-[420px] overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl" style={{ aspectRatio: "4 / 5" }}>
              <video ref={recVideoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
              {recSecs !== null && (
                <div className="absolute left-3 top-3 rounded-md bg-red-600 px-2.5 py-1 text-[13px] font-bold text-white">● {recSecs}s</div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-4">
                {recSecs === null ? (
                  <>
                    <button onClick={beginRecording} className="sq-btn sq-btn--white">● Record 8s</button>
                    <button onClick={closeRecorder} className="sq-btn sq-btn--ghost">Cancel</button>
                  </>
                ) : (
                  <button onClick={stopRecordingEarly} className="sq-btn sq-btn--white">■ Done</button>
                )}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[420px] flex-col gap-3">
              <button onClick={openRecorder} className="sq-btn sq-btn--black w-full py-5 text-[14px]">
                🎥 Record yourself (8 seconds)
              </button>
              <label className="sq-btn w-full cursor-pointer border border-neutral-300 py-4 text-center text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                📁 …or upload a short clip
                <input type="file" accept="video/*" className="hidden" onChange={onFile} />
              </label>
              <label className="sq-btn w-full cursor-pointer border border-neutral-300 py-4 text-center text-neutral-600 hover:border-neutral-900 hover:text-neutral-900">
                🦊 …or upload a character photo
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadCharacter(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <p className="text-center text-[12px] text-neutral-400">
                Characters (mascots, cartoons, animals) need just one clear front-facing photo —
                they&apos;re ready instantly.
              </p>
              <p className="text-center text-[12px] text-neutral-400">
                Face the camera, sit fairly still, mouth closed. Nothing is stored server-side
                beyond the avatar frames on our own GPU box.
              </p>
              {library.length > 0 && (
                <button onClick={() => setWantNew(false)} className="text-[12.5px] text-neutral-500 underline hover:text-neutral-900">
                  ← back to saved avatars
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* Step 2 — generation progress */}
      {busy && (
        <section className="mx-auto mt-10 w-full max-w-[420px]">
          <div className="flex items-center gap-4">
            {clip && (
              <video ref={clipVideoRef} className="h-24 w-24 rounded-xl object-cover" autoPlay muted loop playsInline />
            )}
            <div className="flex-1">
              <p className="text-[14.5px] font-medium">Building your GPU avatar…</p>
              <p className="text-[12.5px] text-neutral-500">{gpuGen?.status} — takes 1–3 minutes. Stay on this page.</p>
              <div className="mt-2 h-[7px] overflow-hidden rounded-full bg-neutral-200">
                <div className="h-full bg-neutral-900 transition-all duration-500" style={{ width: `${gpuGen?.progress ?? 0}%` }} />
              </div>
            </div>
          </div>
        </section>
      )}

      {err && <p className="mx-auto mt-4 max-w-[420px] text-center text-[13px] text-red-600">{err}</p>}

      {/* Step 3 — talk to it */}
      {studio === "ready" && gpuAvatarId && !busy && (
        <section className="mt-10">
          <div className="mb-4 flex items-center justify-center gap-3 text-[13px] text-neutral-500">
            <span>
              Talking as <b>{gpuAvatarId}</b>.
            </span>
            <button onClick={recordNew} className="underline hover:text-neutral-900">
              record a new one
            </button>
          </div>
          {library.length > 1 && (
            <div className="mb-5 flex flex-wrap items-center justify-center gap-2">
              {library.map((a) => (
                <button
                  key={a.avatar_id}
                  onClick={() => pickAvatar(a.avatar_id, a.engine ?? "muse")}
                  title={`switch to ${a.avatar_id}`}
                  className={`overflow-hidden rounded-full border-2 transition ${
                    a.avatar_id === gpuAvatarId
                      ? "border-neutral-900"
                      : "border-transparent opacity-60 hover:opacity-100"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/neural/avatar?thumb=${encodeURIComponent(a.avatar_id)}`}
                    alt=""
                    className="h-12 w-12 bg-neutral-100 object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          {gpuEngine === "ditto" ? (
            <FoxDailyCall key={gpuAvatarId} avatarId={gpuAvatarId} />
          ) : (
            <FoxLiveCall key={`${gpuAvatarId}:${gpuEngine}`} neural neuralAvatarId={gpuAvatarId} neuralEngine={gpuEngine} />
          )}
        </section>
      )}
    </main>
  );
}
