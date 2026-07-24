"use client";

import { useEffect, useRef, useState } from "react";
import Daily, { type DailyCall, type DailyEventObjectTrack } from "@daily-co/daily-js";
import FoxPipecatCall from "./FoxPipecatCall";

/**
 * FoxDailyCall — character-avatar call over Daily's production WebRTC
 * (the transport LemonSlice runs on: SFU-side pacing, echo cancellation,
 * mic auto-gain). The GPU bot joins a private room; we take the other seat.
 *
 * Falls back to the SmallWebRTC path (FoxPipecatCall) when the bot reports
 * no DAILY_API_KEY, so the fox keeps working while keys move around.
 */
export default function FoxDailyCall({ avatarId }: { avatarId: string }) {
  const [phase, setPhase] = useState<"idle" | "connecting" | "live" | "error" | "fallback">("idle");
  const [status, setStatus] = useState("");
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const callRef = useRef<DailyCall | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function beacon(event: string, data: Record<string, unknown> = {}) {
    void fetch("/api/neural/pipecat?path=telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, transport: "daily", ...data, ua: navigator.userAgent.slice(0, 60) }),
    }).catch(() => {});
  }

  useEffect(() => {
    return () => {
      const call = callRef.current;
      callRef.current = null;
      if (call) void call.leave().then(() => call.destroy()).catch(() => {});
    };
  }, []);

  function attachTrack(track: MediaStreamTrack) {
    const v = videoRef.current;
    if (!v) return;
    if (!streamRef.current) streamRef.current = new MediaStream();
    const stream = streamRef.current;
    // one track per kind — replace stale ones after reconnects
    for (const t of stream.getTracks()) {
      if (t.kind === track.kind && t.id !== track.id) stream.removeTrack(t);
    }
    if (!stream.getTracks().some((t) => t.id === track.id)) stream.addTrack(track);
    v.srcObject = stream;
    v.muted = false;
    v.play()
      .then(() => beacon("play_ok", { muted: v.muted, kind: track.kind }))
      .catch((err) => {
        beacon("play_blocked", { err: String((err as Error)?.name) });
        setNeedsUnmute(true);
      });
  }

  async function start() {
    if (callRef.current) return;
    setPhase("connecting");
    setStatus("Connecting to the fox…");
    try {
      const r = await fetch("/api/neural/pipecat?path=daily/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar_id: avatarId }),
      });
      const seat = await r.json();
      if (seat?.error === "daily_not_configured") {
        setPhase("fallback");
        return;
      }
      if (!r.ok || !seat?.room_url) throw new Error(seat?.error ?? `daily start failed (${r.status})`);

      const call = Daily.createCallObject({ subscribeToTracksAutomatically: true });
      callRef.current = call;
      (window as unknown as Record<string, unknown>).__foxDaily = call; // debug handle

      call.on("track-started", (ev: DailyEventObjectTrack) => {
        if (ev.participant?.local) return;
        attachTrack(ev.track);
      });
      call.on("error", (ev) => console.warn("[fox] daily error:", ev));

      try {
        await call.join({ url: seat.room_url, token: seat.token, startVideoOff: true });
      } catch {
        // no mic available (or permission denied) — take a listen-only seat
        await call.join({ url: seat.room_url, token: seat.token, startVideoOff: true, audioSource: false });
      }

      // LOADER UNTIL ABSOLUTELY READY: hold the connecting overlay until the
      // fox's video is actually flowing (the engine primes ~10s server-side)
      setStatus("Getting the fox ready… ✨");
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const v = videoRef.current;
        if (v && v.videoWidth > 0 && v.currentTime > 0.5) break;
        await new Promise((res) => setTimeout(res, 300));
      }
      setPhase("live");
      setStatus("The fox is waking up… he'll greet you in a moment. 🦊");
    } catch (e) {
      console.warn("[fox] daily call failed:", e);
      setPhase("error");
      setStatus("Couldn't reach the fox — is the studio awake?");
      const call = callRef.current;
      callRef.current = null;
      if (call) void call.leave().then(() => call.destroy()).catch(() => {});
    }
  }

  if (phase === "fallback") return <FoxPipecatCall avatarId={avatarId} />;

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div
        className="relative overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl"
        style={{ aspectRatio: "1 / 1" }}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
        {needsUnmute && (
          <button
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.muted = false;
              v.play()
                .then(() => {
                  beacon("unmute_ok", {});
                  setNeedsUnmute(false);
                })
                .catch((e) => beacon("unmute_failed", { err: String((e as Error)?.name) }));
            }}
            className="absolute inset-x-0 bottom-6 mx-auto w-fit rounded-full bg-white/95 px-6 py-3 text-[15px] font-semibold text-neutral-900 shadow-xl"
          >
            🔊 Tap to hear the fox
          </button>
        )}
        {phase !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-900/80 p-6 text-center">
            {phase === "connecting" ? (
              <p className="text-[14px] text-neutral-300">{status}</p>
            ) : (
              <>
                {phase === "error" && <p className="text-[13px] text-red-400">{status}</p>}
                <button onClick={() => void start()} className="sq-btn sq-btn--white">
                  Talk to the Fox
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {phase === "live" && (
        <p className="mt-3 text-center text-[13px] text-neutral-500">{status}</p>
      )}
    </div>
  );
}
