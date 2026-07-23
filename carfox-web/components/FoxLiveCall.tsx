"use client";

/**
 * Car Fox live call — fully self-hosted face, zero avatar vendors:
 *
 *   visitor mic ── PCM16k ──▶ Gemini Live WS (ephemeral token, Puck voice)
 *   Gemini audio (PCM24k) ──▶ WebAudio playback ──▶ FoxLipsync (analyser)
 *   FoxLipsync visemes ──▶ FoxAvatar (parametric SVG fox, lip-synced live)
 *
 * No Daily room, no LemonSlice, no Python sidecar, no GPU server. The token
 * comes from /api/fox-token (single-use, 60s window) so the real Gemini key
 * never reaches the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCar, money, km, type Car } from "@/lib/cars";
import { FoxLipsync, type FoxMouthParams } from "@/lib/foxLipsync";
import type { AvatarConfig } from "@/lib/avatarStore";
import { connectNeuralAvatar, type NeuralSession } from "@/lib/neuralAvatar";
import FoxAvatar, { type FoxSample } from "./FoxAvatar";
import PhotoAvatar from "./PhotoAvatar";
import VideoAvatar from "./VideoAvatar";

const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const SYSTEM_PROMPT = `You are the Car Fox, a quick-witted, upbeat cartoon fox mascot for a curated performance-car lot. Keep replies short and punchy (1-2 sentences), warm and playful, with the occasional fox pun. Never break character. If someone says "show me the Carfax," lean into it — you ARE the Car Fox.
You know the lot's LIVE INVENTORY exactly (real vehicles, real CARFAX-listed history — never invent):
1) 2023 BMW M5 — $83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, 10 service records, Newport Beach.
2) 2024 BMW M4 Competition — $70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys.
3) 2023 Mercedes-AMG GT 63 — $116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, $22,035 below CARFAX value, Newport Beach.
4) 2026 Porsche Panamera GTS — $184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified pre-owned, Pasadena. The flagship.
5) 2018 Chevrolet Camaro SS 1SS — $29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported, 3+ owners — always disclose honestly and suggest an inspection. North Hollywood.
6) 2015 Ford Mustang GT — $18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, 6-speed manual, Bell CA.`;

/** Focused context block appended when the visitor is on a vehicle detail page. */
function vehicleContext(car: Car): string {
  const name = `${car.year} ${car.make} ${car.model}${car.trim ? " " + car.trim : ""}`;
  const history =
    car.history.accidents === "none"
      ? "no accidents or damage reported"
      : "MINOR DAMAGE reported — disclose honestly, suggest an inspection";
  return `

CURRENT PAGE CONTEXT — the visitor is RIGHT NOW looking at this vehicle:
${name} — ${money(car.price)}${car.belowValue ? ` (${money(car.belowValue)} below CARFAX value)` : ""}, ${km(car.miles)}, ${car.engine}, ${car.trans}, ${car.drive}, ${car.mpg} MPG, ${car.exterior} over ${car.interior}, ${car.body}, located ${car.dealerCity}${car.certified ? ", Certified Pre-Owned" : ""}.
VIN ${car.vin}. History: ${history}; ${car.history.owners} owner(s); ${car.history.personalUse ? "personal use" : "commercial use"}; ${car.history.serviceHistory ? `service history on file${car.history.serviceRecords ? ` (${car.history.serviceRecords} records)` : ""}` : "no service records"}.
Assume questions are about THIS car unless they say otherwise. Lead with these exact facts.`;
}

type Phase = "idle" | "connecting" | "live" | "error";

const BOOT_TIPS = ["Brushing the tail…", "Pulling the CARFAX reports…", "Practicing fox puns…"];

export default function FoxLiveCall({
  vehicleSlug,
  compact = false,
  autoStart = false,
  avatar,
  neural = false,
  neuralAvatarId,
  neuralEngine,
}: {
  vehicleSlug?: string;
  compact?: boolean;
  autoStart?: boolean;
  /**
   * Sandbox-only: render this photo avatar instead of the fox. The site-wide
   * dock NEVER passes this — the production fox is not affected by anything
   * saved in the Avatar Lab.
   */
  avatar?: AvatarConfig;
  /**
   * Sandbox-only: route Gemini's voice through the self-hosted GPU lip-sync
   * server (LiveTalking) and render its WebRTC stream — voice and lips come
   * back already synced. Falls back to the local avatar if the VM is down.
   */
  neural?: boolean;
  /** GPU-side avatar to use for this session (from the clip→GPU generator). */
  neuralAvatarId?: string;
  /** which GPU engine drives the avatar: undefined/"muse" | "ditto" (characters) */
  neuralEngine?: string;
}) {
  const car = vehicleSlug ? getCar(vehicleSlug) : undefined;
  const carRef = useRef(car);
  useEffect(() => {
    carRef.current = car;
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Ready when you are.");
  const [muted, setMuted] = useState(false);
  const [micOk, setMicOk] = useState(true);
  const [caption, setCaption] = useState("");
  const [speakingUi, setSpeakingUi] = useState(false);
  const [tipIdx, setTipIdx] = useState(0);
  const [draft, setDraft] = useState("");
  const [neuralOn, setNeuralOn] = useState(false);
  const [neuralFailed, setNeuralFailed] = useState(false);
  const [neuralAspect, setNeuralAspect] = useState("9 / 16");
  const neuralVideoRef = useRef<HTMLVideoElement | null>(null);
  const neuralAudioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const startingRef = useRef(false);

  const s = useRef<{
    ws?: WebSocket;
    ctx?: AudioContext;
    micCtx?: AudioContext;
    micStream?: MediaStream;
    lipsync?: FoxLipsync;
    master?: GainNode;
    neuralSess?: NeuralSession;
    utterBuf: Int16Array[];
    utterLen: number;
    playhead: number;
    sources: AudioBufferSourceNode[];
    micLevel: number;
    lastMouth: FoxMouthParams | null;
    utterance: string;
    dbg: { msgs: number; audioParts: number; schedSec: number; interrupts: number };
  }>({ utterBuf: [], utterLen: 0, playhead: 0, sources: [], micLevel: 0, lastMouth: null, utterance: "", dbg: { msgs: 0, audioParts: 0, schedSec: 0, interrupts: 0 } });

  useEffect(() => () => void stop(), []);

  // StrictMode-safe autostart: the dev double-mount cancels the first timer,
  // so exactly one start() fires.
  useEffect(() => {
    if (!autoStart) return;
    const t = setTimeout(() => void start(), 150);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rotate playful boot messages while connecting (usually <2s now).
  useEffect(() => {
    if (phase !== "connecting") return;
    const id = setInterval(() => setTipIdx((i) => i + 1), 1600);
    return () => clearInterval(id);
  }, [phase]);

  // Attach the neural WebRTC stream once its <video> exists.
  // MuseTalk: video and audio tracks go to SEPARATE elements — it sends no
  // audio frames during silence, and a media element with a starved audio
  // track freezes its whole clock (video included, at ~3s, every time).
  // Ditto: audio is CONTINUOUS, so both tracks share ONE element — the
  // browser then lip-syncs them itself; split elements drift apart.
  useEffect(() => {
    const v = neuralVideoRef.current;
    const a = neuralAudioRef.current;
    const sess = s.current.neuralSess;
    if (!neuralOn || !v || !sess) return;
    if (neuralEngine === "ditto") {
      v.srcObject = sess.stream;
      v.muted = false;
      if (a) a.srcObject = null;
    } else {
      v.srcObject = new MediaStream(sess.stream.getVideoTracks());
      v.muted = true;
      if (a) {
        a.srcObject = new MediaStream(sess.stream.getAudioTracks());
        a.play().catch(() => {});
      }
    }
    v.play()
      .then(() => console.info("[fox] neural media playing, muted:", v.muted))
      .catch((err) => {
        console.warn("[fox] neural play blocked:", err?.name);
        // Same recovery the LemonSlice dock uses: tell the user, unlock on
        // any interaction anywhere on the page.
        setStatus("Click anywhere to enable the fox's audio. 🔊");
        const unlock = () => {
          v.play()
            .then(() => setStatus("Live — just talk. Interrupt him any time. 🦊"))
            .catch(() => {});
          a?.play().catch(() => {});
          document.removeEventListener("click", unlock);
          document.removeEventListener("touchstart", unlock);
        };
        document.addEventListener("click", unlock);
        document.addEventListener("touchstart", unlock);
      });
    const sync = () => {
      if (v.videoWidth && v.videoHeight) setNeuralAspect(`${v.videoWidth} / ${v.videoHeight}`);
    };
    v.addEventListener("loadedmetadata", sync);
    v.addEventListener("resize", sync);
    return () => {
      v.removeEventListener("loadedmetadata", sync);
      v.removeEventListener("resize", sync);
    };
  }, [neuralOn, neuralEngine]);

  // Speaking state for the frame glow — polled, not per-frame React churn.
  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => setSpeakingUi(!!s.current.lastMouth?.speaking), 250);
    return () => clearInterval(id);
  }, [phase]);

  /** FoxAvatar pulls this once per animation frame. */
  const sampleFox = useCallback((): FoxSample => {
    const st = s.current;
    st.lastMouth = st.lipsync ? st.lipsync.update() : null;
    return { mouth: st.lastMouth, micLevel: st.micLevel };
  }, []);

  function send(obj: unknown) {
    const ws = s.current.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /** Neural mode: concatenate buffered PCM and ship it to the GPU server. */
  function flushUtterance() {
    const st = s.current;
    if (!st.neuralSess || st.utterLen === 0) return;
    const all = new Int16Array(st.utterLen);
    let o = 0;
    for (const c of st.utterBuf) {
      all.set(c, o);
      o += c.length;
    }
    st.utterBuf = [];
    st.utterLen = 0;
    void st.neuralSess.speak(all, 24000);
  }

  function sendText(text: string) {
    send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  async function start() {
    if (startingRef.current || s.current.ws) return;
    startingRef.current = true;
    const st = s.current;
    try {
      setPhase("connecting");
      setStatus("Waking up the fox…");

      // Neural mode: connect to the GPU lip-sync server first so its stream
      // is ready when speech starts. Failure falls back to the local avatar.
      if (neural) {
        try {
          setStatus("Connecting to the GPU face…");
          const sess = await connectNeuralAvatar(neuralAvatarId, neuralEngine);
          st.neuralSess = sess;
          setNeuralOn(true);
        } catch (e) {
          console.warn("neural connect failed:", e);
          setNeuralFailed(true);
          setStatus("GPU face offline — using the local avatar this call.");
        }
      }

      // Single-use ephemeral token — the real key stays on the server.
      const resp = await fetch("/api/fox-token", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "token mint failed");

      // Output pipeline: PCM chunks → master gain → speakers, with the
      // lip-sync analyser tapping the same node the ear hears.
      const ctx = new AudioContext();
      st.ctx = ctx;
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
        const unlock = () => {
          ctx.resume().catch(() => {});
          document.removeEventListener("click", unlock);
        };
        document.addEventListener("click", unlock);
      }
      const master = ctx.createGain();
      master.connect(ctx.destination);
      st.master = master;
      st.lipsync = new FoxLipsync(ctx, master);
      st.playhead = 0;

      const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(data.token)}`);
      st.ws = ws;

      ws.onopen = () => {
        send({
          setup: {
            model: GEMINI_MODEL,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
            },
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT + (carRef.current ? vehicleContext(carRef.current) : "") }],
            },
            outputAudioTranscription: {}, // live captions under the fox
            realtimeInputConfig: {
              automaticActivityDetection: {
                // Room noise kept barging in and cutting the fox off —
                // require clear, sustained speech.
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 300,
                silenceDurationMs: 800,
              },
            },
          },
        });
      };

      ws.onmessage = async (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
        const msg = JSON.parse(raw);
        st.dbg.msgs++;

        if (msg.setupComplete) {
          await startMic(); // continues gracefully without a mic
          setPhase("live");
          const c = carRef.current;
          const greet = () =>
            sendText(
              c
                ? `Greet me in one short energetic sentence and offer to talk about the ${c.year} ${c.make} ${c.model} I'm looking at.`
                : "Greet me in one short energetic sentence and ask what kind of car I'm hunting for."
            );
          if (neural && neuralEngine === "ditto" && s.current.neuralSess) {
            // The character pipeline needs ~10s of priming before it can move
            // lips; greeting during that window would play over a still face.
            setStatus("The fox is waking up… one moment. 🦊");
            setTimeout(() => {
              setStatus("Live — just talk. Interrupt him any time. 🦊");
              greet();
            }, 12000);
          } else {
            setStatus("Live — just talk. Interrupt him any time. 🦊");
            greet();
          }
          return;
        }
        if (msg.goAway) {
          setStatus("The fox has to trot off in a moment — wrapping up.");
          return;
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) {
          // Barge-in: silence everything that hasn't played yet.
          st.dbg.interrupts++;
          st.sources.forEach((src) => {
            try { src.stop(); } catch {}
          });
          st.sources = [];
          st.playhead = 0;
          st.utterance = "";
          st.utterBuf = [];
          st.utterLen = 0;
          void st.neuralSess?.interrupt();
          return;
        }

        if (sc.outputTranscription?.text) {
          st.utterance += sc.outputTranscription.text;
          setCaption(st.utterance);
        }
        if (sc.turnComplete) {
          st.utterance = "";
          flushUtterance(); // neural mode: ship the finished utterance's tail
        }

        for (const p of sc.modelTurn?.parts || []) {
          const b64 = p.inlineData?.data;
          if (!b64) continue;
          const bin = atob(b64);
          const pcm = new Int16Array(bin.length / 2);
          for (let i = 0; i < pcm.length; i++) {
            pcm[i] = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i);
          }
          st.dbg.audioParts++;
          st.dbg.schedSec += pcm.length / 24000;
          // Neural mode: don't play locally — buffer and ship to the GPU,
          // whose WebRTC stream carries voice and lips already in sync.
          if (st.neuralSess) {
            st.utterBuf.push(pcm);
            st.utterLen += pcm.length;
            if (st.utterLen >= 24000 * 2) flushUtterance(); // ~2s chunks
            continue;
          }
          // 24k mono PCM → AudioBuffer (the context resamples on playback).
          const buf = ctx.createBuffer(1, pcm.length, 24000);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(master);
          const at = Math.max(ctx.currentTime + 0.06, st.playhead);
          src.start(at);
          st.playhead = at + buf.duration;
          st.sources.push(src);
          src.onended = () => {
            st.sources = st.sources.filter((x) => x !== src);
          };
        }
      };

      ws.onerror = () => {
        setPhase("error");
        setStatus("Lost the fox — connection error. Try again?");
      };
      ws.onclose = (e) => {
        // Normal teardown clears s.current.ws first; anything else is a drop.
        if (s.current.ws === ws) {
          s.current.ws = undefined;
          setPhase((p) => (p === "live" || p === "connecting" ? "error" : p));
          setStatus(`The fox dropped the line (${e.code}). Try again?`);
        }
      };

      // Dev hooks for the self-test / console poking.
      (window as unknown as Record<string, unknown>).__foxsay = (t: string) => sendText(t);
      (window as unknown as Record<string, unknown>).__foxdbg = () => ({
        ...st.dbg,
        wsState: st.ws?.readyState,
        playhead: st.playhead,
        ctxTime: st.ctx?.currentTime,
        mouth: st.lastMouth,
      });
    } catch (e) {
      console.error(e);
      setPhase("error");
      setStatus("Start failed: " + (e instanceof Error ? e.message : String(e)));
      await stop(false);
    } finally {
      startingRef.current = false;
    }
  }

  async function startMic() {
    const st = s.current;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      st.micStream = mic;
      // Use the device's native sample rate (Chrome silently fails when a
      // MediaStreamSource joins a context at a mismatched rate), then
      // downsample to 16k ourselves.
      const micCtx = new AudioContext();
      st.micCtx = micCtx;
      const inRate = micCtx.sampleRate;
      const srcNode = micCtx.createMediaStreamSource(mic);
      const proc = micCtx.createScriptProcessor(4096, 1, 1);
      const muteGain = micCtx.createGain();
      muteGain.gain.value = 0; // never feed the mic to the speakers
      srcNode.connect(proc);
      proc.connect(muteGain).connect(micCtx.destination);

      let gateOpenUntil = 0;
      proc.onaudioprocess = (e) => {
        if (!st.ws || st.ws.readyState !== 1) return;
        const f32 = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < f32.length; i += 16) sum += f32[i] * f32[i];
        const rms = Math.sqrt(sum / (f32.length / 16));
        st.micLevel = Math.min(1, rms * 8);
        if (mutedRef.current) return;
        // Noise gate: ambient noise kept cutting the fox off mid-sentence.
        // Open on clear voice, hold 700ms after.
        const now = performance.now();
        if (rms > 0.02) gateOpenUntil = now + 700;
        if (now > gateOpenUntil) return;

        const ratio = inRate / 16000;
        const outLen = Math.floor(f32.length / ratio);
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const pos = i * ratio;
          const i0 = Math.floor(pos);
          const i1 = Math.min(i0 + 1, f32.length - 1);
          const frac = pos - i0;
          const v = Math.max(-1, Math.min(1, f32[i0] * (1 - frac) + f32[i1] * frac));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        let bin = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        // realtimeInput.audio is the current field — mediaChunks is
        // deprecated and silently ignored by gemini-3.1-flash-live-preview.
        send({ realtimeInput: { audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" } } });
      };
      setMicOk(true);
    } catch (e) {
      console.warn("mic unavailable:", e);
      setMicOk(false);
    }
  }

  async function stop(resetPhase = true) {
    const st = s.current;
    const ws = st.ws;
    st.ws = undefined; // mark as intentional teardown before closing
    try { ws?.close(); } catch {}
    try { st.neuralSess?.close(); } catch {}
    st.neuralSess = undefined;
    st.utterBuf = [];
    st.utterLen = 0;
    setNeuralOn(false);
    setNeuralFailed(false);
    st.sources.forEach((src) => { try { src.stop(); } catch {} });
    st.sources = [];
    try { st.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await st.micCtx?.close(); } catch {}
    try { await st.ctx?.close(); } catch {}
    st.micCtx = undefined;
    st.ctx = undefined;
    st.lipsync = undefined;
    st.master = undefined;
    st.playhead = 0;
    st.micLevel = 0;
    st.lastMouth = null;
    st.utterance = "";
    setCaption("");
    setSpeakingUi(false);
    setMuted(false);
    mutedRef.current = false;
    if (resetPhase) {
      setPhase("idle");
      setStatus("Call ended.");
    }
  }

  function toggleMute() {
    setMuted((m) => {
      mutedRef.current = !m;
      return !m;
    });
  }

  function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sendText(text);
    setDraft("");
  }

  return (
    <div className={compact ? "px-4 pb-4 pt-3 text-center" : "mx-auto max-w-3xl px-6 text-center"}>
      <div
        style={{
          maxHeight: compact ? "calc(78dvh - 190px)" : "70dvh",
          aspectRatio: neuralOn ? neuralAspect : avatar ? `${avatar.w} / ${avatar.h}` : "480 / 560",
        }}
        className={`fox-live-frame relative mx-auto w-full overflow-hidden bg-neutral-900 shadow-2xl ${
          speakingUi ? "is-speaking" : ""
        } ${compact ? "max-w-[260px] rounded-xl" : "max-w-[420px] rounded-2xl"}`}
      >
        {neuralOn ? (
          <>
            <video ref={neuralVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            <audio ref={neuralAudioRef} autoPlay />
          </>
        ) : avatar?.mode === "video" ? (
          <VideoAvatar key={avatar.videoUrl} config={avatar} sample={sampleFox} className="h-full w-full" />
        ) : avatar ? (
          <PhotoAvatar key={avatar.createdAt} config={avatar} sample={sampleFox} className="h-full w-full" />
        ) : (
          <FoxAvatar sample={sampleFox} className="h-full w-full" />
        )}
        {neuralFailed && phase !== "idle" && (
          <div className="absolute inset-x-0 top-0 z-10 bg-amber-400/95 px-3 py-2 text-center text-[12.5px] font-semibold leading-snug text-black">
            ⚠️ GPU face offline — this is the LOCAL fallback, not the neural avatar. Start the
            fox-neural-mouth VM, then restart this call.
          </div>
        )}
        {caption && phase === "live" && (
          <div className="fox-caption">
            <span>{caption}</span>
          </div>
        )}
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
              </>
            ) : (
              <div className="text-[15px] text-neutral-300">The Car Fox appears here.</div>
            )}
          </div>
        )}
      </div>

      <div className={`${compact ? "mt-3" : "mt-8"} flex items-center justify-center gap-3`}>
        {phase === "idle" || phase === "error" ? (
          <button onClick={start} className="sq-btn sq-btn--black">
            Talk to the Fox
          </button>
        ) : (
          <>
            {micOk && (
              <button onClick={toggleMute} className="sq-btn border border-neutral-900 text-neutral-900">
                {muted ? "Unmute mic" : "Mute mic"}
              </button>
            )}
            <button onClick={() => stop()} className="sq-btn sq-btn--black">
              End call
            </button>
          </>
        )}
      </div>

      {phase === "live" && (
        <form onSubmit={submitDraft} className="mx-auto mt-3 flex max-w-[300px] items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={micOk ? "…or type to the fox" : "Mic unavailable — type to the fox"}
            className="min-w-0 flex-1 border border-neutral-300 bg-white px-3 py-2 text-[13.5px] outline-none focus:border-neutral-900"
            aria-label="Type a message to the Car Fox"
          />
          <button type="submit" className="sq-btn sq-btn--black !px-3 !py-2 text-[12px]">
            Send
          </button>
        </form>
      )}

      {!compact && <p className="mt-4 text-[14px] text-neutral-500">{status}</p>}
      {!compact && (
        <p className="mt-2 text-[12px] text-neutral-400">
          Brain &amp; voice: Gemini Live (ephemeral token, browser-direct) · Face: 100% local SVG +
          WebAudio visemes — no avatar vendor, no per-minute cost.
        </p>
      )}
      {compact && (phase === "live" || phase === "error") && (
        <p className={`mt-2 text-[12px] ${phase === "error" ? "text-red-600" : "text-neutral-500"}`}>
          {status}
        </p>
      )}
    </div>
  );
}
