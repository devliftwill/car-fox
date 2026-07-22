"use client";

/**
 * Fox Lab — visual QA bench for the SVG fox rig. No Gemini, no mic, no cost.
 *
 *  - Manual: drive open/round/energy with sliders.
 *  - Vowel drill: synthesizes formant audio (AH → EE → OO → SS) through a real
 *    AudioContext + FoxLipsync, exercising the exact pipeline a live call uses,
 *    so what the mouth does here is what it does on a call.
 *  - Idle: hands off — blinks, gaze, ear twitches, sway.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import FoxAvatar, { type FoxSample } from "@/components/FoxAvatar";
import { FoxLipsync } from "@/lib/foxLipsync";

type Mode = "idle" | "manual" | "synth";

// Rough formant targets (F1, F2) per vowel + a sibilant noise stage.
const DRILL: { label: string; f1?: number; f2?: number; noise?: boolean }[] = [
  { label: "AH", f1: 780, f2: 1250 },
  { label: "EE", f1: 300, f2: 2600 },
  { label: "OO", f1: 320, f2: 700 },
  { label: "SS", noise: true },
];

export default function FoxLab() {
  const [mode, setMode] = useState<Mode>("idle");
  const [open, setOpen] = useState(0.4);
  const [round, setRound] = useState(0.2);
  const [energy, setEnergy] = useState(0.5);
  const [stage, setStage] = useState("");
  const manual = useRef({ open, round, energy });
  const modeRef = useRef(mode);
  useEffect(() => {
    manual.current = { open, round, energy };
    modeRef.current = mode;
  });

  const synth = useRef<{ ctx?: AudioContext; lipsync?: FoxLipsync; timer?: ReturnType<typeof setInterval> }>({});

  const sample = useCallback((): FoxSample => {
    const m = modeRef.current;
    if (m === "manual") {
      const { open, round, energy } = manual.current;
      return { mouth: { open, round, energy, speaking: energy > 0.05 } };
    }
    if (m === "synth" && synth.current.lipsync) {
      return { mouth: synth.current.lipsync.update() };
    }
    return { mouth: null };
  }, []);

  function stopSynth() {
    const s = synth.current;
    if (s.timer) clearInterval(s.timer);
    s.ctx?.close().catch(() => {});
    synth.current = {};
    setStage("");
  }

  function startSynth() {
    stopSynth();
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);
    const lipsync = new FoxLipsync(ctx, master);
    synth.current = { ctx, lipsync };
    let i = 0;

    const playStage = () => {
      const d = DRILL[i % DRILL.length];
      i++;
      setStage(d.label);
      const t0 = ctx.currentTime;
      const dur = 0.42;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(1, t0 + 0.04);
      env.gain.setValueAtTime(1, t0 + dur - 0.08);
      env.gain.linearRampToValueAtTime(0, t0 + dur);
      env.connect(master);
      if (d.noise) {
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let j = 0; j < len; j++) ch[j] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 5200;
        bp.Q.value = 0.8;
        src.connect(bp).connect(env);
        src.start(t0);
      } else {
        for (const f of [d.f1!, d.f2!]) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = f;
          const g = ctx.createGain();
          g.gain.value = f === d.f1 ? 0.6 : 0.35;
          osc.connect(g).connect(env);
          osc.start(t0);
          osc.stop(t0 + dur);
        }
      }
    };
    playStage();
    synth.current.timer = setInterval(playStage, 500);
  }

  function setModeSafe(m: Mode) {
    if (m !== "synth") stopSynth();
    else startSynth();
    setMode(m);
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="sq-kicker text-neutral-400">Internal</p>
      <h1 className="text-3xl font-light tracking-tight">Fox Lab</h1>
      <p className="mt-2 text-[14px] text-neutral-500">
        QA bench for the local SVG fox — the face that replaced LemonSlice.
      </p>

      <div className="mt-10 flex flex-col items-start gap-10 md:flex-row">
        <div className="fox-live-frame relative w-full max-w-[360px] overflow-hidden rounded-2xl shadow-2xl" style={{ aspectRatio: "480 / 560" }}>
          <FoxAvatar sample={sample} className="h-full w-full" />
          {stage && (
            <div className="absolute right-3 top-3 rounded-md bg-black/60 px-2.5 py-1 text-[12px] font-semibold tracking-widest text-white">
              {stage}
            </div>
          )}
        </div>

        <div className="w-full max-w-[320px] space-y-8">
          <div className="flex gap-2">
            {(["idle", "manual", "synth"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setModeSafe(m)}
                className={`sq-btn ${mode === m ? "sq-btn--black" : "border border-neutral-300 text-neutral-500"}`}
              >
                {m === "synth" ? "vowel drill" : m}
              </button>
            ))}
          </div>

          {mode === "manual" && (
            <div className="space-y-5">
              {(
                [
                  ["open (jaw)", open, setOpen],
                  ["round (lips)", round, setRound],
                  ["energy", energy, setEnergy],
                ] as [string, number, (v: number) => void][]
              ).map(([label, v, set]) => (
                <label key={label} className="block">
                  <span className="text-[12px] uppercase tracking-[0.14em] text-neutral-500">
                    {label} — {v.toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={v}
                    onChange={(e) => set(Number(e.target.value))}
                    className="mt-1 w-full"
                  />
                </label>
              ))}
            </div>
          )}

          {mode === "synth" && (
            <p className="text-[13.5px] leading-relaxed text-neutral-500">
              Playing synthesized formants through the real FoxLipsync analyser:
              AH should drop the jaw, EE should spread the lips thin, OO should
              purse them into a ring, SS should nearly close with teeth showing.
            </p>
          )}
          {mode === "idle" && (
            <p className="text-[13.5px] leading-relaxed text-neutral-500">
              Hands off — he should blink (occasionally double-blink), glance
              around, twitch an ear every few seconds, sway, and breathe.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
