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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

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
      pc.addTransceiver("video", { direction: "sendrecv" });
      pc.createDataChannel("chat");

      const stream = new MediaStream();
      pc.ontrack = (ev) => {
        stream.addTrack(ev.track);
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        v.muted = false;
        v.play().catch(() => {
          setStatus("Click anywhere to enable the fox's audio. 🔊");
          const unlock = () => {
            v.play()
              .then(() => setStatus("Live — just talk. 🦊"))
              .catch(() => {});
            document.removeEventListener("click", unlock);
          };
          document.addEventListener("click", unlock);
        });
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
