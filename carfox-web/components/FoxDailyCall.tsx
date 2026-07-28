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
export default function FoxDailyCall({
  avatarId,
  autoStart = false,
  holdId,
}: {
  avatarId: string;
  /** Begin the call on mount. For the meeting-bot surface, where the page is
   *  rendered inside a bot's browser and nobody can press a button. */
  autoStart?: boolean;
  /** Identifies this page's claim on the single-session GPU. Two bots in the
   *  same meeting each asking to "hold" used to evict one another forever;
   *  with an owner, the second one is told the box is busy instead. */
  holdId?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "connecting" | "live" | "error" | "fallback">("idle");
  const [status, setStatus] = useState("");
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const callRef = useRef<DailyCall | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);

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
      micRef.current?.getTracks().forEach((t) => t.stop());
      micRef.current = null;
    };
  }, []);

  /**
   * THE EAR. Recall.ai feeds the meeting's mixed audio to this page as a
   * microphone, so getUserMedia here IS everyone in the meeting talking, and
   * publishing it into the Daily room is what lets the fox hear them.
   *
   * Done explicitly rather than leaving it to Daily's default capture for one
   * reason: when it fails it has to fail LOUDLY. The old code fell back to a
   * listen-only seat inside a catch, which produced a fox that joined, looked
   * perfect, spoke its intro and then ignored every question — with nothing
   * anywhere saying "no microphone". Beacon what we got, and meter it so a
   * silent room and a dead device are distinguishable.
   */
  /** RMS of a stream over `ms`, so "is anything actually on this wire" is a
   *  number instead of an assumption. */
  async function measure(stream: MediaStream, ms: number): Promise<number> {
    const ctx = new AudioContext();
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let peak = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        analyser.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        await new Promise((r) => setTimeout(r, 100));
      }
      return peak;
    } finally {
      void ctx.close();
    }
  }

  async function captureMeetingAudio(): Promise<MediaStreamTrack | null> {
    try {
      // RAW. Recall's virtual mic already carries conference-processed audio,
      // and Chrome's own AEC/noise-suppression on top of a virtual device is
      // the prime suspect for the dead-silent capture we measured in a live
      // meeting: a live track, correct device, peak 4e-05 — orders of
      // magnitude below any real room's noise floor. Nothing to cancel here
      // anyway; the fox's voice is never mixed back into this input.
      const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: RAW });
      micRef.current = stream;
      let track = stream.getAudioTracks()[0] ?? null;

      // Which inputs exist at all? Labels are only readable after a grant,
      // so this has to come after getUserMedia. If the default device turns
      // out to be the silent one, the meeting audio may be on another.
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput",
      );
      beacon("mic_ok", {
        label: track?.label?.slice(0, 40),
        state: track?.readyState,
        inputs: inputs.map((d) => `${d.deviceId.slice(0, 8)}:${d.label.slice(0, 24)}`),
      });

      // Self-heal: if the chosen input is digitally silent, walk the other
      // inputs and keep the first one carrying signal. Silence during this
      // window is ambiguous (nobody may be talking), so only a device that is
      // BELOW the floor of even an empty room gets abandoned.
      if (inputs.length > 1 && (await measure(stream, 4000)) < 1e-4) {
        for (const d of inputs) {
          if (d.deviceId === track?.getSettings().deviceId) continue;
          try {
            const alt = await navigator.mediaDevices.getUserMedia({
              audio: { ...RAW, deviceId: { exact: d.deviceId } },
            });
            const peak = await measure(alt, 3000);
            beacon("mic_probe", { dev: d.label.slice(0, 24), peak: +peak.toFixed(6) });
            if (peak >= 1e-4) {
              micRef.current?.getTracks().forEach((t) => t.stop());
              micRef.current = alt;
              track = alt.getAudioTracks()[0] ?? track;
              beacon("mic_switched", { to: d.label.slice(0, 24) });
              break;
            }
            alt.getTracks().forEach((t) => t.stop());
          } catch {
            /* device may be unopenable; try the next */
          }
        }
      }

      // Rolling level, reported every 10s. This is the page-side half of the
      // /health "ear" figure on the GPU; together they localise silence to
      // either the meeting->page hop or the page->fox hop.
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // whichever stream we settled on above, not necessarily the first
      ctx.createMediaStreamSource(micRef.current ?? stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let peak = 0;
      let voiced = 0;
      let n = 0;
      const id = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        peak = Math.max(peak, rms);
        if (rms > 0.005) voiced++;
        if (++n % 20 === 0) beacon("mic_level", { rms: +rms.toFixed(5), peak: +peak.toFixed(5), voiced, n });
      }, 500);
      track?.addEventListener("ended", () => {
        clearInterval(id);
        beacon("mic_ended", {});
      });
      return track;
    } catch (e) {
      beacon("mic_failed", { err: String((e as Error)?.name ?? e) });
      return null;
    }
  }

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
      // On the bot surface, take the meeting's audio BEFORE asking for a room:
      // if there is no ear there is no conversation, and finding that out
      // after the fox is already on screen helps nobody.
      const micTrack = autoStart ? await captureMeetingAudio() : null;

      const r = await fetch("/api/neural/pipecat?path=daily/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // hold: a meeting owns the box outright — a passer-by on the website
        // must not be able to evict a live call (the GPU runs one at a time)
        body: JSON.stringify({ avatar_id: avatarId, hold: autoStart, hold_id: holdId ?? "" }),
      });
      const seat = await r.json();
      if (seat?.error === "daily_not_configured") {
        setPhase("fallback");
        return;
      }
      if (seat?.error === "busy") {
        setPhase("error");
        setStatus("The fox is on another call right now — try again in a minute.");
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

      // AUTO-RECOVER. A meeting bot has nobody to click "try again": when the
      // GPU side ends a session the page just sat there streaming a black
      // frame into a live meeting. Rebuild the call instead.
      if (autoStart) {
        call.on("left-meeting", () => {
          beacon("call_dropped_relaunching", {});
          const dead = callRef.current;
          callRef.current = null;
          void dead?.destroy().catch(() => {});
          setPhase("idle");
          setTimeout(() => void start(), 2000);
        });
      }

      try {
        await call.join({
          url: seat.room_url,
          token: seat.token,
          startVideoOff: true,
          // the bot surface publishes the meeting audio it just captured;
          // everywhere else Daily picks the user's own microphone as usual
          ...(micTrack ? { audioSource: micTrack } : {}),
        });
      } catch (joinErr) {
        // A listen-only seat is a DEAF fox. Acceptable for a human visitor who
        // declined mic permission (they can still watch); never silently
        // acceptable for the meeting bot, so say so out loud.
        beacon("join_retry_listen_only", { err: String((joinErr as Error)?.name ?? joinErr), autoStart });
        await call.join({ url: seat.room_url, token: seat.token, startVideoOff: true, audioSource: false });
      }

      // Confirm the ear survived the join — Daily can accept a track and still
      // end up publishing nothing (muted seat, device grabbed elsewhere).
      try {
        const me = call.participants()?.local;
        const audio = me?.tracks?.audio;
        beacon("mic_published", { state: audio?.state, off: !me?.audio });
        if (autoStart && audio?.state !== "playable") call.setLocalAudio(true);
      } catch {
        /* participants() is best-effort telemetry, never a call blocker */
      }

      // LOADER UNTIL THE FOX ACTUALLY MOVES: while the engine primes, the
      // stream carries a still photo — revealing that reads as "frozen".
      // Watch a downscaled pixel-diff and only drop the overlay once real
      // motion arrives (45s cap so nobody stares at a spinner forever).
      setStatus("Getting the fox ready… ✨");
      const probe = document.createElement("canvas");
      probe.width = probe.height = 32;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      let prevPx: Uint8ClampedArray | null = null;
      let movingHits = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        const v = videoRef.current;
        if (v && v.videoWidth > 0 && pctx) {
          pctx.drawImage(v, 0, 0, 32, 32);
          const px = pctx.getImageData(0, 0, 32, 32).data;
          if (prevPx) {
            let diff = 0;
            for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prevPx[i]);
            (window as unknown as { __foxMotion?: number[] }).__foxMotion?.push(diff);
            movingHits = diff > 600 ? movingHits + 1 : 0;
            if (movingHits >= 2) break;
          }
          prevPx = new Uint8ClampedArray(px);
        }
        await new Promise((res) => setTimeout(res, 400));
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

  useEffect(() => {
    if (!autoStart) return;
    if (phase !== "idle") return;
    void start();
    // start() is stable for the life of the component; re-running on every
    // phase change would restart the call mid-conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div
        className={`fox-live-frame ${phase === "live" ? "is-live" : ""}`}
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
          <div className="fox-live-wake">
            {phase === "connecting" ? (
              <>
                <span className="fox-live-pulse" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span className="fox-live-status">{status || "Connecting"}</span>
                <span className="fox-live-hint">
                  He renders in real time on our own GPU — a moment while he wakes.
                </span>
              </>
            ) : (
              <>
                {phase === "error" && (
                  <span className="fox-live-hint" style={{ color: "rgba(255,140,120,.95)" }}>
                    {status}
                  </span>
                )}
                <button onClick={() => void start()} className="sq-btn sq-btn--white">
                  Talk to the Fox
                </button>
              </>
            )}
          </div>
        )}
        {phase === "live" && status && <div className="fox-live-cap">{status}</div>}
      </div>
      {phase === "live" && (
        <p className="mt-3 text-center text-[13px] text-neutral-500">{status}</p>
      )}
    </div>
  );
}
