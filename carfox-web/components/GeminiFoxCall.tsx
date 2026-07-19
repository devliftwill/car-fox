"use client";

/**
 * Direct Gemini Live x LemonSlice fox call — the Seny pattern, no LiveKit:
 *
 *   mic ── PCM16k ──▶ Gemini Live WS (gemini-3.1-flash-live-preview, native audio)
 *   Gemini audio (PCM24k) ──▶ WebAudio ──▶ custom track ──▶ Daily room (LemonSlice-hosted)
 *   LemonSlice avatar lip-syncs that track ──▶ fox video+audio back ──▶ <video>
 */
import { useEffect, useRef, useState } from "react";
import Daily, { DailyCall } from "@daily-co/daily-js";
import { getCar, money, km, type Car } from "@/lib/cars";

const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";

const SYSTEM_PROMPT = `You are the Car Fox, a quick-witted, upbeat cartoon fox mascot for a curated performance-car lot. Keep replies short and punchy (1-2 sentences), warm and playful, with the occasional fox pun. Never break character. If someone says "show me the Carfax," lean into it — you ARE the Car Fox.
You know the lot's LIVE INVENTORY exactly (real vehicles, real CARFAX-listed history — never invent):
1) 2023 BMW M5 — $83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, 10 service records, Newport Beach.
2) 2024 BMW M4 Competition — $70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys.
3) 2023 Mercedes-AMG GT 63 — $116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, $22,035 below CARFAX value, Newport Beach.
4) 2026 Porsche Panamera GTS — $184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified pre-owned, Pasadena. The flagship.
5) 2018 Chevrolet Camaro SS 1SS — $29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported, 3+ owners — always disclose honestly and suggest an inspection. North Hollywood.
6) 2015 Ford Mustang GT — $18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, 6-speed manual, Bell CA.`;

type Phase = "idle" | "connecting" | "live" | "error";

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

export default function GeminiFoxCall({ vehicleSlug }: { vehicleSlug?: string }) {
  const car = vehicleSlug ? getCar(vehicleSlug) : undefined;
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Ready when you are.");
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [foxSec, setFoxSec] = useState(0); // seconds of Gemini speech received
  const [test, setTest] = useState<null | {
    checks: { label: string; pass: boolean }[];
    verdict?: "PASS" | "FAIL" | "NO_START";
    elapsed: number;
  }>(null);
  const mutedRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const state = useRef<{
    ws?: WebSocket;
    call?: DailyCall;
    ctx?: AudioContext;
    micCtx?: AudioContext;
    micStream?: MediaStream;
    dest?: MediaStreamAudioDestinationNode;
    playhead?: number;
    controlUrl?: string;
    sessionId?: string;
    speaking?: boolean;
    finishTimer?: ReturnType<typeof setTimeout>;
    gen?: MediaStreamTrack & { writable: WritableStream };
    writer?: WritableStreamDefaultWriter;
    queue?: unknown[];
    tsUs?: number;
    t0?: number;
    pumpTimer?: ReturnType<typeof setInterval>;
    pumpFrames?: () => void;
    sources: AudioBufferSourceNode[];
    monCtx?: AudioContext;
    dbg: {
      msgs: number;
      audioParts: number;
      schedSec: number;
      interrupts: number;
      tracks: string[];
      signals: string[];
      remoteRMSMax: number;
    };
  }>({
    sources: [],
    dbg: { msgs: 0, audioParts: 0, schedSec: 0, interrupts: 0, tracks: [], signals: [], remoteRMSMax: 0 },
  });

  useEffect(() => () => void stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat: surface how much fox speech has actually streamed in.
  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => setFoxSec(state.current.dbg?.schedSec ?? 0), 500);
    return () => clearInterval(id);
  }, [phase]);

  async function start() {
    const s = state.current;
    try {
      setPhase("connecting");
      setStatus("Creating fox session…");
      const resp = await fetch("/api/fox-session", { method: "POST" });
      const sess = await resp.json();
      if (!resp.ok) throw new Error(sess.detail || sess.error);
      s.controlUrl = sess.control_url;
      s.sessionId = sess.session_id;

      // ---- Gemini's voice → native audio track via insertable streams.
      // NOT WebAudio: Chrome transmits SILENCE over WebRTC for
      // MediaStreamAudioDestinationNode tracks (verified against a real mic
      // track through the same room/SFU). MediaStreamTrackGenerator produces
      // a device-class track that WebRTC actually sends.
      const w = window as unknown as {
        MediaStreamTrackGenerator?: new (init: { kind: string }) => MediaStreamTrack & {
          writable: WritableStream;
        };
        AudioData?: new (init: {
          format: string;
          sampleRate: number;
          numberOfFrames: number;
          numberOfChannels: number;
          timestamp: number;
          data: Int16Array;
        }) => unknown;
      };
      if (!w.MediaStreamTrackGenerator || !w.AudioData) {
        throw new Error("This browser lacks MediaStreamTrackGenerator (use Chrome/Edge).");
      }
      const gen = new w.MediaStreamTrackGenerator({ kind: "audio" });
      const writer = gen.writable.getWriter();
      s.gen = gen;
      s.writer = writer;
      s.queue = [];
      s.tsUs = 0; // next frame timestamp (µs on the s.t0 clock)
      s.t0 = performance.now();
      // Pace frames to the generator ~400ms ahead of real time. Runs on a
      // timer AND on every WS message (timers are throttled to ~1/s in
      // background tabs; WS events are not).
      const pumpFrames = () => {
        const elapsedUs = (performance.now() - (s.t0 || 0)) * 1000;
        while (s.queue!.length && (s.queue![0] as { timestamp: number }).timestamp <= elapsedUs + 400_000) {
          writer.write(s.queue!.shift()).catch(() => {});
        }
      };
      s.pumpFrames = pumpFrames;
      s.pumpTimer = setInterval(pumpFrames, 50);
      s.playhead = 0;
      s.dbg = { msgs: 0, audioParts: 0, schedSec: 0, interrupts: 0, tracks: [], signals: [], remoteRMSMax: 0 };
      // dev: expose internals for live inspection
      (window as unknown as Record<string, unknown>).__foxdest = new MediaStream([gen]);
      // live diagnostics — readable from the console as window.__foxdbg()
      (window as unknown as Record<string, unknown>).__foxdbg = () => ({
        ...s.dbg,
        genState: s.gen?.readyState,
        queued: s.queue?.length,
        playhead: (s.tsUs || 0) / 1e6,
        wsState: s.ws?.readyState,
        localAudio: s.call?.participants()?.local?.tracks?.audio?.state,
        remotes: Object.values(s.call?.participants() || {})
          .filter((p) => !(p as { local?: boolean }).local)
          .map((p) => {
            const pp = p as { user_name?: string; tracks?: Record<string, { state?: string }> };
            return `${pp.user_name || "?"}: a=${pp.tracks?.audio?.state} v=${pp.tracks?.video?.state}`;
          }),
      });

      // ---- Join the LemonSlice-hosted Daily room
      setStatus("Joining the fox's room…");
      const call = Daily.createCallObject({ subscribeToTracksAutomatically: true });
      s.call = call;
      (window as unknown as Record<string, unknown>).__foxcall = call; // dev inspection

      let greeted = false;
      let avatarReady = false;
      const greet = () => {
        // Wait for BOTH: Gemini WS live AND the avatar actually in the room —
        // otherwise the greeting audio plays into the void while the fox boots.
        if (greeted || !avatarReady || !s.ws || s.ws.readyState !== 1) return;
        greeted = true;
        s.ws.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text: car
                        ? `Greet me in one short energetic sentence and offer to talk about the ${car.year} ${car.make} ${car.model} I'm looking at.`
                        : "Greet me in one short energetic sentence.",
                    },
                  ],
                },
              ],
              turnComplete: true,
            },
          })
        );
        setStatus("Live — the fox is saying hi… 🦊");
      };

      // LemonSlice reports pipeline problems over the app-message channel
      // (bot_ready, daily_error, video_generation_error, idle_timeout…)
      call.on("app-message", (ev) => {
        try {
          s.dbg.signals.push(`in:${JSON.stringify((ev as { data?: unknown }).data).slice(0, 120)}`);
        } catch {}
      });

      call.on("track-started", (ev) => {
        s.dbg.tracks.push(`${ev.participant?.local ? "local" : "remote"}:${ev.track?.kind}`);
        if (!ev.participant || ev.participant.local) return;
        // The avatar publishes synced video+audio — render both.
        if (videoRef.current) {
          const remote = videoRef.current.srcObject as MediaStream | null;
          const ms = remote instanceof MediaStream ? remote : new MediaStream();
          ms.addTrack(ev.track);
          videoRef.current.srcObject = ms;
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {
            // Autoplay with sound blocked — retry muted-unmute on next user click
            setStatus("Click anywhere to enable the fox's audio.");
            const unlock = () => {
              videoRef.current?.play().catch(() => {});
              document.removeEventListener("click", unlock);
            };
            document.addEventListener("click", unlock);
          });
        }
        // Greet only once the avatar is actually in the room and listening —
        // greeting at setupComplete plays into the void while the avatar boots.
        if (ev.track?.kind === "audio") {
          avatarReady = true;
          setTimeout(greet, 800);
          // Monitor return audio: proof the avatar is really speaking
          // (feeds dbg.remoteRMSMax, used by the self-test).
          try {
            const track = ev.track;
            if (!s.monCtx) s.monCtx = new AudioContext();
            const an = s.monCtx.createAnalyser();
            an.fftSize = 1024;
            s.monCtx.createMediaStreamSource(new MediaStream([track])).connect(an);
            const buf = new Float32Array(an.fftSize);
            const tick = setInterval(() => {
              if (!s.monCtx || track.readyState === "ended") {
                clearInterval(tick);
                return;
              }
              an.getFloatTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
              s.dbg.remoteRMSMax = Math.max(s.dbg.remoteRMSMax, Math.sqrt(sum / (buf.length / 4)));
            }, 250);
          } catch {}
        }
      });

      await call.join({ url: sess.room_url, startAudioOff: true, startVideoOff: true });
      // LemonSlice only lip-syncs a Daily CUSTOM track named "stream"
      // (see pipecat lemonslice transport: _transport_destination = "stream").
      // Publishing as a normal mic track gets ignored — the fox just idles.
      await call.startCustomTrack({ track: gen, trackName: "stream" });

      // ---- Gemini Live over raw WebSocket (Seny-style)
      setStatus("Waking up Gemini…");
      const ws = new WebSocket(
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${sess.geminiKey}`
      );
      s.ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: GEMINI_MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
                },
              },
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT + (car ? vehicleContext(car) : "") }],
              },
              realtimeInputConfig: {
                automaticActivityDetection: {
                  // Room noise was constantly barging in and cutting the fox
                  // off mid-sentence — require clear, sustained speech.
                  startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                  endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                  prefixPaddingMs: 300,
                  silenceDurationMs: 800,
                },
              },
            },
          })
        );
      };

      // dev hook: make the fox say something on demand (used for lip-sync verification)
      (window as unknown as Record<string, unknown>).__foxsay = (t: string) =>
        ws.readyState === 1 &&
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: t }] }],
              turnComplete: true,
            },
          })
        );

      ws.onmessage = async (ev) => {
        const data = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
        const msg = JSON.parse(data);
        s.dbg.msgs++;
        s.pumpFrames?.(); // background-tab safe pacing

        if (msg.setupComplete) {
          await startMic();
          setPhase("live");
          setStatus("Live — waiting for the fox to wake up…");
          greet(); // no-ops until the avatar's track is up; track-started also calls it
          return;
        }
        // LemonSlice signaling protocol (from pipecat's lemonslice transport):
        // the avatar only starts generating lip-synced video after a
        // "response_started" app-message, and needs "response_finished" /
        // "interrupt" to close each utterance. Audio on the "stream" track
        // alone is ignored.
        const signal = (event: string) => {
          try {
            call.sendAppMessage({ event, session_id: s.sessionId }, "*");
            s.dbg.signals.push(event);
          } catch {}
        };

        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.interrupted) {
          // user barged in — cut the fox off: drop everything not yet written
          s.dbg.interrupts++;
          s.queue = [];
          s.tsUs = (performance.now() - (s.t0 || 0)) * 1000;
          if (s.finishTimer) clearTimeout(s.finishTimer);
          if (s.speaking) {
            s.speaking = false;
            signal("interrupt");
          }
          return;
        }
        const parts = sc.modelTurn?.parts || [];
        for (const p of parts) {
          const b64 = p.inlineData?.data;
          if (!b64) continue;
          const raw = atob(b64);
          const pcm = new Int16Array(raw.length / 2);
          for (let i = 0; i < pcm.length; i++) {
            pcm[i] = (raw.charCodeAt(2 * i + 1) << 8) | raw.charCodeAt(2 * i);
          }
          // Wrap Gemini's 24k PCM in an AudioData frame for the generator.
          const elapsedUs = (performance.now() - (s.t0 || 0)) * 1000;
          const ts = Math.max(s.tsUs || 0, elapsedUs);
          const durUs = (pcm.length / 24000) * 1e6;
          s.queue!.push(
            new w.AudioData!({
              format: "s16",
              sampleRate: 24000,
              numberOfFrames: pcm.length,
              numberOfChannels: 1,
              timestamp: Math.round(ts),
              data: pcm,
            })
          );
          s.tsUs = ts + durUs;
          s.dbg.audioParts++;
          s.dbg.schedSec += pcm.length / 24000;

          // Utterance framing for LemonSlice
          if (!s.speaking) {
            s.speaking = true;
            signal("response_started");
          }
          // (Re)arm response_finished for when the queued audio actually ends
          if (s.finishTimer) clearTimeout(s.finishTimer);
          const msLeft = Math.max(0, ((s.tsUs || 0) - elapsedUs) / 1000) + 400;
          s.finishTimer = setTimeout(() => {
            if (s.speaking) {
              s.speaking = false;
              signal("response_finished");
            }
          }, msLeft);
        }
      };
      ws.onerror = () => {
        setPhase("error");
        setStatus("Gemini connection error — check the key / model access.");
      };
      ws.onclose = (e) => {
        if (phase !== "idle") setStatus(`Gemini closed (${e.code}) ${e.reason || ""}`);
      };
      return true;
    } catch (e) {
      console.error(e);
      setPhase("error");
      setStatus("Start failed: " + (e instanceof Error ? e.message : String(e)));
      await stop();
      return false;
    }
  }

  async function startMic() {
    const s = state.current;
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    s.micStream = mic;
    // IMPORTANT: use the device's native sample rate (Chrome silently fails when
    // a MediaStreamSource is attached to a context at a mismatched rate),
    // then downsample to 16k ourselves.
    const micCtx = new AudioContext();
    s.micCtx = micCtx;
    const inRate = micCtx.sampleRate; // typically 48000
    const srcNode = micCtx.createMediaStreamSource(mic);
    const proc = micCtx.createScriptProcessor(4096, 1, 1);
    const mute = micCtx.createGain();
    mute.gain.value = 0; // never feed mic to speakers
    srcNode.connect(proc);
    proc.connect(mute).connect(micCtx.destination);

    let levelTick = 0;
    let gateOpenUntil = 0; // noise gate: only forward real speech to Gemini
    proc.onaudioprocess = (e) => {
      if (!s.ws || s.ws.readyState !== 1) return;
      const f32 = e.inputBuffer.getChannelData(0);

      // RMS for meter + noise gate
      let sum = 0;
      for (let i = 0; i < f32.length; i += 16) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / (f32.length / 16));
      if (++levelTick % 3 === 0) setMicLevel(Math.min(1, rms * 8));
      if (mutedRef.current) return;

      // Gate: ambient room noise was constantly barging in and cutting the
      // fox off mid-sentence. Open on clear voice, hold open 700ms after.
      const now = performance.now();
      if (rms > 0.02) gateOpenUntil = now + 700;
      if (now > gateOpenUntil) return;

      // downsample native rate -> 16k (linear interpolation)
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
      // NOTE: realtimeInput.audio is the current format — mediaChunks is
      // deprecated and silently ignored by gemini-3.1-flash-live-preview.
      s.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" },
          },
        })
      );
    };
  }

  /**
   * Credit-efficient proof run: starts a real call, verifies every pipeline
   * stage, and ends the call the moment there's a verdict (~10 credits on
   * PASS instead of ~50 for a leisurely manual test).
   */
  async function runSelfTest() {
    setTest({ checks: [], elapsed: 0 });
    const ok = await start();
    const s = state.current;
    if (!ok) {
      setTest({ checks: [], verdict: "NO_START", elapsed: 0 });
      return;
    }
    const stages: [string, () => boolean][] = [
      ["LemonSlice session created", () => !!s.sessionId],
      ["Avatar joined the room", () => s.dbg.tracks.includes("remote:video")],
      ["Gemini Live connected", () => s.ws?.readyState === 1],
      ["Gemini voice streaming out", () => s.dbg.schedSec > 0.5],
      ["LemonSlice signaled (response_started)", () => s.dbg.signals.includes("response_started")],
      ["Fox speaking back (return audio detected)", () => s.dbg.remoteRMSMax > 0.01],
    ];
    const t0 = performance.now();
    const LIMIT_MS = 60_000;
    await new Promise<void>((resolve) => {
      const poll = setInterval(async () => {
        const elapsed = (performance.now() - t0) / 1000;
        const checks = stages.map(([label, fn]) => ({ label, pass: fn() }));
        const allPass = checks.every((c) => c.pass);
        const timedOut = performance.now() - t0 > LIMIT_MS;
        setTest({ checks, elapsed, verdict: allPass ? "PASS" : timedOut ? "FAIL" : undefined });
        if (allPass || timedOut) {
          clearInterval(poll);
          await stop(); // end immediately — every extra second is credits
          setStatus(allPass ? "Self-test PASSED — the fox works end to end. 🦊✅" : "Self-test failed — see checklist.");
          resolve();
        }
      }, 500);
    });
  }

  async function stop() {
    const s = state.current;
    if (s.finishTimer) clearTimeout(s.finishTimer);
    if (s.pumpTimer) clearInterval(s.pumpTimer);
    try {
      await s.writer?.close();
    } catch {}
    try {
      s.gen?.stop();
    } catch {}
    try {
      s.ws?.close();
    } catch {}
    try {
      s.micStream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      await s.micCtx?.close();
    } catch {}
    try {
      await s.monCtx?.close();
      s.monCtx = undefined;
    } catch {}
    try {
      await s.ctx?.close();
    } catch {}
    try {
      await s.call?.leave();
      await s.call?.destroy();
    } catch {}
    if (s.controlUrl) {
      fetch("/api/fox-session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ control_url: s.controlUrl }),
      }).catch(() => {});
    }
    if (videoRef.current) videoRef.current.srcObject = null; // no frozen ghost fox
    setMicLevel(0);
    state.current = {
      sources: [],
      dbg: { msgs: 0, audioParts: 0, schedSec: 0, interrupts: 0, tracks: [], signals: [], remoteRMSMax: 0 },
    };
    setPhase("idle");
    setStatus("Call ended.");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 text-center">
      <div className="relative mx-auto aspect-[2/3] w-full max-w-[420px] overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl">
        <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
        {phase !== "live" && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-[15px] text-neutral-300">
            {phase === "connecting" ? status : "The Gemini-powered fox appears here."}
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-center gap-3">
        {phase === "idle" || phase === "error" ? (
          <>
            <button onClick={start} className="sq-btn sq-btn--black">
              Start Gemini call
            </button>
            <button
              onClick={runSelfTest}
              className="sq-btn border border-neutral-300 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900"
              title="Runs a short real call, checks every pipeline stage, ends immediately"
            >
              Run self-test
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() =>
                setMuted((m) => {
                  mutedRef.current = !m;
                  return !m;
                })
              }
              className="sq-btn border border-neutral-900 text-neutral-900"
            >
              {muted ? "Unmute mic" : "Mute mic"}
            </button>
            <button onClick={stop} className="sq-btn sq-btn--black">
              End call
            </button>
          </>
        )}
      </div>
      {phase === "live" && (
        <div className="mx-auto mt-5 flex max-w-[340px] items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.16em] text-neutral-400">Mic</span>
          <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-green-500 transition-[width] duration-100"
              style={{ width: `${Math.round(micLevel * 100)}%` }}
            />
          </div>
          <span
            className={`whitespace-nowrap text-[11px] uppercase tracking-[0.16em] ${
              foxSec > 0 ? "text-green-600" : "text-neutral-400"
            }`}
            title="Seconds of Gemini speech streamed to the fox"
          >
            Fox {foxSec.toFixed(1)}s
          </span>
        </div>
      )}
      <p className="mt-4 text-[14px] text-neutral-500">{status}</p>
      {test && (
        <div className="mx-auto mt-6 max-w-[420px] rounded-xl border border-neutral-200 p-5 text-left">
          <div className="mb-3 flex items-center justify-between">
            <span className="sq-kicker text-neutral-500">Pipeline self-test</span>
            <span className="text-[12px] text-neutral-400">{test.elapsed.toFixed(0)}s</span>
          </div>
          {test.verdict === "NO_START" ? (
            <p className="text-[14px] text-red-600">
              Couldn&apos;t start a session — check LemonSlice credits / keys (status above).
            </p>
          ) : (
            <ul className="space-y-2">
              {test.checks.map((c) => (
                <li key={c.label} className="flex items-center gap-2.5 text-[14px]">
                  <span>{c.pass ? "✅" : test.verdict === "FAIL" ? "❌" : "⏳"}</span>
                  <span className={c.pass ? "" : "text-neutral-400"}>{c.label}</span>
                </li>
              ))}
            </ul>
          )}
          {test.verdict === "PASS" && (
            <p className="mt-4 text-[14.5px] font-semibold text-green-700">
              PASS — full pipeline verified. Fox is production-ready.
            </p>
          )}
          {test.verdict === "FAIL" && (
            <p className="mt-4 text-[14.5px] font-semibold text-red-600">
              FAIL — first unchecked stage above is where it broke.
            </p>
          )}
        </div>
      )}
      <p className="mt-2 text-[12px] text-neutral-400">
        Brain &amp; voice: Gemini 3.1 Flash Live (direct WebSocket, Seny-style) · Face: LemonSlice ·
        Room: LemonSlice-hosted Daily — no extra accounts.
      </p>
    </div>
  );
}
