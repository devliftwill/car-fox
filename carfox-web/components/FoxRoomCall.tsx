"use client";

/**
 * Car Fox live call — official pipecat-sidecar architecture:
 *
 *   visitor mic ──▶ LemonSlice-hosted Daily room ──▶ fox-agent (pipecat:
 *   Gemini 3.1 Flash Live, Puck voice) ──▶ LemonSlice avatar ──▶ synced
 *   fox video+audio back into the room ──▶ this component renders it.
 *
 * The browser does no AI plumbing anymore — it's just a well-behaved
 * room participant. /api/fox-room spawns and kills the bot per call.
 */
import { useEffect, useRef, useState } from "react";
import Daily, { DailyCall } from "@daily-co/daily-js";

type Phase = "idle" | "connecting" | "live" | "error";

const BOOT_TIPS = [
  "Brushing the tail…",
  "Pulling the CARFAX reports…",
  "Dusting off the showroom…",
  "Warming up the mic…",
  "He's trotting in now…",
  "Practicing fox puns…",
];

export default function FoxRoomCall({
  vehicleSlug,
  compact = false,
  autoStart = false,
}: {
  vehicleSlug?: string;
  compact?: boolean;
  autoStart?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Ready when you are.");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [tipIdx, setTipIdx] = useState(0);
  // Match the frame to the fox's real dimensions so object-cover never crops
  // his sides. Defaults to the portrait avatar ratio until metadata lands.
  const [videoAspect, setVideoAspect] = useState("2 / 3");
  const videoRef = useRef<HTMLVideoElement>(null);
  const callRef = useRef<DailyCall | null>(null);
  const startingRef = useRef(false); // guards double-start (React StrictMode, double-clicks)
  const disposersRef = useRef<(() => void)[]>([]); // speech-detector cleanup

  useEffect(() => () => void stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // StrictMode-safe autostart: the dev double-mount cancels the first timer,
  // so exactly one start() fires.
  useEffect(() => {
    if (!autoStart) return;
    const t = setTimeout(() => void start(), 150);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the frame locked to the video's true aspect ratio. Media elements
  // fire "resize" whenever the incoming track's dimensions change, so the
  // frame follows the fox even if LemonSlice renegotiates resolution.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      if (v.videoWidth && v.videoHeight) {
        setVideoAspect(`${v.videoWidth} / ${v.videoHeight}`);
      }
    };
    v.addEventListener("loadedmetadata", sync);
    v.addEventListener("resize", sync);
    return () => {
      v.removeEventListener("loadedmetadata", sync);
      v.removeEventListener("resize", sync);
    };
  }, []);

  // Rotate the playful boot messages while connecting.
  useEffect(() => {
    if (phase !== "connecting") return;
    const id = setInterval(() => setTipIdx((i) => i + 1), 2400);
    return () => clearInterval(id);
  }, [phase]);

  async function start() {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      setPhase("connecting");
      setStatus("Waking up the fox…");
      const resp = await fetch("/api/fox-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle: vehicleSlug ?? null }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Could not start the fox");

      setStatus("Joining the fox's room…");
      const call = Daily.createCallObject({ subscribeToTracksAutomatically: true });
      callRef.current = call;

      call.on("track-started", (ev) => {
        if (!ev.participant || ev.participant.local) return;
        if (ev.participant.user_name !== "LemonSlice") return; // only render the avatar
        if (videoRef.current) {
          const cur = videoRef.current.srcObject;
          const ms = cur instanceof MediaStream ? cur : new MediaStream();
          ms.addTrack(ev.track);
          videoRef.current.srcObject = ms;
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {
            setStatus("Click anywhere to enable the fox's audio.");
            const unlock = () => {
              videoRef.current?.play().catch(() => {});
              document.removeEventListener("click", unlock);
            };
            document.addEventListener("click", unlock);
          });
        }
        if (ev.track.kind === "audio") {
          // He's in the room, but revealing him now shows a frozen, silent fox
          // while Gemini + lip-sync spin up (~3-5s). Keep the loader until his
          // audio track carries actual speech, then reveal mid-hello.
          setStatus("He's here — clearing his throat…");
          try {
            const ac = new AudioContext();
            const an = ac.createAnalyser();
            an.fftSize = 1024;
            // MUST analyse the exact MediaStream the <video> element plays —
            // Chrome only pumps remote audio into WebAudio for element-attached
            // streams, and the pump is per-stream, not per-track.
            const attached = videoRef.current?.srcObject;
            ac.createMediaStreamSource(
              attached instanceof MediaStream ? attached : new MediaStream([ev.track])
            ).connect(an);
            const buf = new Float32Array(an.fftSize);
            let done = false;
            const reveal = () => {
              if (done) return;
              done = true;
              clearInterval(iv);
              clearTimeout(fallback);
              ac.close().catch(() => {});
              if (!callRef.current) return; // call already ended
              callRef.current.setLocalAudio(!mutedRef.current); // apply mute pref
              setPhase("live");
              setStatus("Live — just talk. Interrupt him any time. 🦊");
            };
            const iv = setInterval(() => {
              an.getFloatTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i += 2) sum += buf[i] * buf[i];
              if (Math.sqrt(sum / (buf.length / 2)) > 0.015) reveal();
            }, 120);
            const fallback = setTimeout(reveal, 8000); // never strand the loader
            disposersRef.current.push(() => {
              done = true;
              clearInterval(iv);
              clearTimeout(fallback);
              ac.close().catch(() => {});
            });
          } catch {
            callRef.current?.setLocalAudio(!mutedRef.current);
            setPhase("live"); // analyser unavailable — reveal immediately
          }
        }
      });

      call.on("participant-left", (ev) => {
        if (ev.participant?.user_name === "LemonSlice") {
          setStatus("The fox left the call.");
          void stop();
        }
      });

      await call.join({
        url: data.room_url,
        userName: "visitor",
        startVideoOff: true,
        // Mic must be HOT from the start: Gemini Live stalls generation when
        // the session has no live audio input at all (verified — a cold mic
        // made the kickoff silently hang and the avatar bail after 30s).
        startAudioOff: false,
      });
      setStatus("Connected — the fox is joining…");
    } catch (e) {
      console.error(e);
      setPhase("error");
      setStatus("Start failed: " + (e instanceof Error ? e.message : String(e)));
      await stop(false);
    } finally {
      startingRef.current = false;
    }
  }

  async function stop(resetPhase = true) {
    disposersRef.current.forEach((d) => d());
    disposersRef.current = [];
    const call = callRef.current;
    callRef.current = null;
    try {
      await call?.leave();
      await call?.destroy();
    } catch {}
    // Kill the sidecar → ends the LemonSlice session → stops the credit meter.
    fetch("/api/fox-room", { method: "DELETE" }).catch(() => {});
    if (videoRef.current) videoRef.current.srcObject = null;
    if (resetPhase) {
      setPhase("idle");
      setStatus("Call ended.");
    }
    setMuted(false);
  }

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    mutedRef.current = next;
    call.setLocalAudio(!next);
    setMuted(next);
  }

  return (
    <div className={compact ? "px-4 pb-4 pt-3 text-center" : "mx-auto max-w-3xl px-6 text-center"}>
      <div
        style={{
          aspectRatio: videoAspect,
          // In the docked widget, leave room for the header + call controls so
          // they stay visible without scrolling on short/landscape screens.
          maxHeight: compact ? "calc(78dvh - 150px)" : "80dvh",
        }}
        className={`relative mx-auto w-full overflow-hidden bg-neutral-900 shadow-2xl ${
          compact ? "max-w-[260px] rounded-xl" : "max-w-[440px] rounded-2xl"
        }`}
      >
        <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
        {phase !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-900 p-6 text-center">
            {phase === "connecting" ? (
              <>
                <div className="fox-boot-avatar">
                  <span />
                  <span />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/carfox-avatar.png" alt="" />
                </div>
                <div className="text-[14.5px] font-medium text-white">{status}</div>
                <div className="min-h-[18px] text-[13px] text-neutral-400">
                  {BOOT_TIPS[tipIdx % BOOT_TIPS.length]}
                </div>
                <div className="text-[10.5px] uppercase tracking-[0.18em] text-neutral-500">
                  Usually ready in under 10 seconds
                </div>
              </>
            ) : (
              <div className="text-[15px] text-neutral-300">The Car Fox appears here.</div>
            )}
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-center gap-3">
        {phase === "idle" || phase === "error" ? (
          <button onClick={start} className="sq-btn sq-btn--black">
            Talk to the Fox
          </button>
        ) : (
          <>
            <button
              onClick={toggleMute}
              className="sq-btn border border-neutral-900 text-neutral-900"
            >
              {muted ? "Unmute mic" : "Mute mic"}
            </button>
            <button onClick={() => stop()} className="sq-btn sq-btn--black">
              End call
            </button>
          </>
        )}
      </div>
      {!compact && <p className="mt-4 text-[14px] text-neutral-500">{status}</p>}
      {!compact && (
        <p className="mt-2 text-[12px] text-neutral-400">
          Brain &amp; voice: Gemini 3.1 Flash Live (Puck) via Pipecat · Face: LemonSlice · Sessions
          auto-end when you leave — no runaway credits.
        </p>
      )}
      {compact && (phase === "live" || phase === "error") && (
        <p className={`mt-3 text-[12px] ${phase === "error" ? "text-red-600" : "text-neutral-500"}`}>
          {status}
        </p>
      )}
    </div>
  );
}
