"use client";

import { useEffect, useRef, useState } from "react";

/**
 * FoxPipecatCall — character-avatar call over the Pipecat bot.
 *
 * The heavy lifting happens server-side (Pipecat: Gemini Live voice loop +
 * Ditto face + professional A/V pacing — the LemonSlice architecture). This
 * client just does a plain WebRTC offer/answer with the bot: microphone up,
 * one video+audio stream down, both tracks on ONE element so the browser
 * keeps them in sync.
 */
export default function FoxPipecatCall({ avatarId }: { avatarId: string }) {
  const [phase, setPhase] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [status, setStatus] = useState("");
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioSeenRef = useRef(false);

  function beacon(event: string, data: Record<string, unknown> = {}) {
    void fetch("/api/neural/pipecat?path=telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...data, ua: navigator.userAgent.slice(0, 60) }),
    }).catch(() => {});
  }

  useEffect(() => {
    return () => {
      try {
        pcRef.current?.close();
      } catch {}
    };
  }, []);

  async function start() {
    if (pcRef.current) return;
    setPhase("connecting");
    setStatus("Connecting to the fox…");
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;
      (window as unknown as Record<string, unknown>).__foxPc = pc; // debug handle
      pc.onconnectionstatechange = () => console.info("[fox] pc:", pc.connectionState);

      // SmallWebRTC contract: first two transceivers are audio then video,
      // BOTH sendrecv (the bot force-sets directions and replaces sender
      // tracks) — plus a data channel for its app messages.
      let micTrack: MediaStreamTrack | null = null;
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        micTrack = mic.getAudioTracks()[0] ?? null;
      } catch {
        console.warn("[fox] no mic — listen-only call");
      }
      const audioTx = pc.addTransceiver("audio", { direction: "sendrecv" });
      if (micTrack) void audioTx.sender.replaceTrack(micTrack);
      // A real (dummy) local video track — matches the reference client's
      // offer shape; a trackless m-line left the bot's video unsent.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d")?.fillRect(0, 0, 2, 2);
      const dummy = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream })
        .captureStream(1)
        .getVideoTracks()[0];
      pc.addTransceiver(dummy, { direction: "sendrecv" });
      pc.createDataChannel("chat");

      const stream = new MediaStream();
      pc.ontrack = (ev) => {
        stream.addTrack(ev.track);
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        v.muted = false;
        v.play()
          .then(() => beacon("play_ok", { muted: v.muted }))
          .catch((err) => {
            beacon("play_blocked", { err: String(err?.name) });
            setNeedsUnmute(true);
          });
        if (ev.track.kind === "audio" && !audioSeenRef.current) {
          audioSeenRef.current = true;
          // self-verify audibility: measure what the speakers actually get
          try {
            const ctx = new AudioContext();
            void ctx.resume().catch(() => {});
            const an = ctx.createAnalyser();
            an.fftSize = 2048;
            ctx.createMediaStreamSource(new MediaStream([ev.track])).connect(an);
            const buf = new Float32Array(an.fftSize);
            let peak = 0;
            let reports = 0;
            const meter = setInterval(() => {
              an.getFloatTimeDomainData(buf);
              let s = 0;
              for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
              peak = Math.max(peak, Math.sqrt(s / buf.length));
              reports += 1;
              if (reports === 15 || reports === 40) {
                beacon("audio_meter", {
                  atSec: reports,
                  peakRms: Math.round(peak * 1000) / 1000,
                  muted: v.muted,
                  paused: v.paused,
                });
                if (reports === 40) clearInterval(meter);
              }
            }, 1000);
          } catch {}
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((res) => {
        if (pc.iceGatheringState === "complete") return res();
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            res();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
        setTimeout(res, 2500);
      });

      const r = await fetch("/api/neural/pipecat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
          avatar_id: avatarId,
        }),
      });
      if (!r.ok) throw new Error(`bot offer failed (${r.status})`);
      const ans = await r.json();
      await pc.setRemoteDescription({ sdp: ans.sdp, type: ans.type });

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
      console.warn("[fox] pipecat call failed:", e);
      setPhase("error");
      setStatus("Couldn't reach the fox — is the studio awake?");
      try {
        pcRef.current?.close();
      } catch {}
      pcRef.current = null;
    }
  }

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
                .catch((e) => beacon("unmute_failed", { err: String(e?.name) }));
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
