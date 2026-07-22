/**
 * neuralAvatar — browser client for our self-hosted GPU lip-sync server
 * (LiveTalking + wav2lip256/MuseTalk on the fox-neural-mouth VM).
 *
 * Media flows browser⇄VM over WebRTC (video+audio, already lip-synced).
 * Signaling and audio uploads go through our own /api/neural/* proxy routes —
 * the page is HTTPS and the VM speaks HTTP, so the browser can't call it
 * directly (mixed content), but our Vercel functions can.
 *
 *   connect()          → POST /api/neural/offer     (SDP exchange)
 *   speak(pcm)         → POST /api/neural/audio     (WAV per utterance)
 *   interrupt()        → POST /api/neural/interrupt (barge-in: flush queue)
 */

export type NeuralSession = {
  stream: MediaStream;
  sessionid: string | number;
  speak: (pcm: Int16Array, sampleRate: number) => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => void;
};

/** Minimal RIFF/WAVE wrapper for 16-bit mono PCM. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const byteLen = pcm.length * 2;
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wr(0, "RIFF");
  v.setUint32(4, 36 + byteLen, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wr(36, "data");
  v.setUint32(40, byteLen, true);
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: "audio/wav" });
}

export async function connectNeuralAvatar(avatarId?: string): Promise<NeuralSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const stream = new MediaStream();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (ev) => stream.addTrack(ev.track);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Wait for ICE gathering so the SDP carries our candidates (LiveTalking
  // expects a complete offer; trickle isn't part of its /offer contract).
  await new Promise<void>((res) => {
    if (pc.iceGatheringState === "complete") return res();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        res();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(res, 2000); // don't hang on pathological networks
  });

  const r = await fetch("/api/neural/offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription!.sdp,
      type: pc.localDescription!.type,
      ...(avatarId ? { avatar_id: avatarId } : {}),
    }),
  });
  if (!r.ok) {
    pc.close();
    throw new Error(`neural server offer failed (${r.status})`);
  }
  const ans = await r.json();
  await pc.setRemoteDescription({ sdp: ans.sdp, type: ans.type });
  const sessionid = ans.sessionid;

  return {
    stream,
    sessionid,
    speak: async (pcm, sampleRate) => {
      const fd = new FormData();
      fd.append("sessionid", String(sessionid));
      fd.append("file", pcmToWav(pcm, sampleRate), "utterance.wav");
      await fetch("/api/neural/audio", { method: "POST", body: fd });
    },
    interrupt: async () => {
      await fetch("/api/neural/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionid }),
      });
    },
    close: () => {
      try {
        pc.close();
      } catch {}
    },
  };
}
