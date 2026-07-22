"use client";

/**
 * FoxAvatar — the Car Fox, drawn and animated entirely in the browser.
 *
 * A layered SVG bust (russet fox, white muzzle, amber eyes, CAR FOX tee)
 * whose mouth is a *parametric* shape rebuilt every frame from two numbers —
 * open (jaw) and round (lips) — supplied by FoxLipsync. Everything else that
 * makes him feel alive runs on internal timers: blinks with the occasional
 * double-blink, gaze saccades, ear twitches, brow emphasis on loud syllables,
 * idle sway, breathing.
 *
 * No video, no GPU inference, no vendor: this component IS the fox's face.
 *
 * The parent drives it through `sample`, called once per animation frame:
 * return the current mouth params (and mic level) or null when idle.
 */
import { useEffect, useRef } from "react";
import type { FoxMouthParams } from "@/lib/foxLipsync";
import { mouthGeometry } from "@/lib/foxMouth";

export type FoxSample = { mouth: FoxMouthParams | null; micLevel?: number };

export default function FoxAvatar({
  sample,
  className,
}: {
  sample?: () => FoxSample;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sampleRef = useRef(sample);
  useEffect(() => {
    sampleRef.current = sample;
  });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // The rig is driven imperatively (one rAF, ~15 attribute writes/frame) so
    // React never re-renders during speech. Nodes are tagged, not ref'd.
    const $ = <T extends SVGElement = SVGGElement>(name: string) =>
      svg.querySelector(`[data-fox="${name}"]`) as T | null;
    const el = {
      head: $("head"), body: $("body"), earL: $("earL"), earR: $("earR"),
      browL: $("browL"), browR: $("browR"), irisL: $("irisL"), irisR: $("irisR"),
      lidL: $("lidL"), lidR: $("lidR"),
      lip: $<SVGPathElement>("lip"), cavity: $<SVGPathElement>("cavity"),
      cavityClip: $<SVGPathElement>("cavityClip"), teeth: $<SVGPathElement>("teeth"),
      tongue: $<SVGEllipseElement>("tongue"),
    };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Animation state (all timers in ms on the performance.now() clock)
    let raf = 0;
    let blinkAt = performance.now() + 1200 + Math.random() * 2000;
    let blinkT = -1; // -1 = not blinking, else ms since blink start
    let doubleBlink = false;
    const gaze = { x: 0, y: 0, tx: 0, ty: 0, nextAt: 0 };
    const twitch = { ear: 0 as 0 | 1, t: -1, nextAt: performance.now() + 2600 + Math.random() * 4000 };
    const mouth = { open: 0, round: 0 }; // locally eased copy

    let lastTick = 0;
    const tick = () => {
      lastTick = performance.now();
      // Cancel-then-schedule keeps exactly one pending frame even when the
      // watchdog drives ticks (rAF is paused entirely in hidden/embedded tabs).
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const t = now / 1000;
      const s: FoxSample = sampleRef.current?.() ?? { mouth: null };
      const m = s.mouth;
      const energy = m?.energy ?? 0;
      const speaking = m?.speaking ?? false;
      const listening = !speaking && (s.micLevel ?? 0) > 0.12;

      // ---- mouth (ease toward driver params; drift shut when idle)
      const openT = m ? m.open : 0;
      const roundT = m ? m.round : mouth.round * 0.9;
      mouth.open += (openT - mouth.open) * 0.5;
      mouth.round += (roundT - mouth.round) * 0.35;
      const g = mouthGeometry(mouth.open, mouth.round);
      el.cavity?.setAttribute("d", g.cavity);
      el.cavityClip?.setAttribute("d", g.cavity);
      el.lip?.setAttribute("d", g.lip);
      el.teeth?.setAttribute("d", g.teeth);
      const cavityOn = Math.min(1, Math.max(0, (mouth.open - 0.045) * 14));
      el.cavity?.setAttribute("opacity", cavityOn.toFixed(3));
      el.teeth?.setAttribute("opacity", cavityOn.toFixed(3));
      el.lip?.setAttribute("opacity", Math.max(0, 1 - mouth.open * 2.4).toFixed(3));
      if (el.tongue) {
        el.tongue.setAttribute("opacity", mouth.open > 0.22 ? "1" : "0");
        el.tongue.setAttribute("cy", String(g.botY - 8));
        el.tongue.setAttribute("rx", String(g.hw * 0.6));
        el.tongue.setAttribute("ry", String(6 + 16 * mouth.open));
      }

      // ---- head: idle sway + speech bob (+ curious tilt while listening)
      const sway = reduceMotion ? 0 : 1;
      const bobY = sway * (Math.sin(t * 1.5) * 2.5 + energy * Math.sin(t * 11) * 3.2);
      const rot =
        sway * (Math.sin(t * 0.6) * 1.1 + energy * Math.sin(t * 7.3) * 1.8) +
        (listening ? 2.2 : 0);
      el.head?.setAttribute("transform", `translate(0 ${bobY.toFixed(2)}) rotate(${rot.toFixed(2)} 240 260)`);

      // ---- breathing
      const breath = 1 + (reduceMotion ? 0 : 0.008 * Math.sin(t * 1.1));
      el.body?.setAttribute("transform", `translate(0 ${(560 * (1 - breath)).toFixed(2)}) scale(1 ${breath.toFixed(4)})`);

      // ---- ears: scheduled twitch + tiny speech shiver + perk when listening
      let twitchRot = 0;
      if (twitch.t >= 0) {
        const p = (now - twitch.t) / 240;
        if (p >= 1) {
          twitch.t = -1;
          twitch.nextAt = now + 2600 + Math.random() * 4600;
          twitch.ear = Math.random() < 0.5 ? 0 : 1;
        } else {
          twitchRot = Math.sin(p * Math.PI) * 9;
        }
      } else if (now >= twitch.nextAt) {
        twitch.t = now;
      }
      const shiver = energy * Math.sin(t * 13) * 1.2;
      const perk = listening ? -4 : 0;
      el.earL?.setAttribute(
        "transform",
        `rotate(${(-(twitch.ear === 0 ? twitchRot : 0) - shiver + perk).toFixed(2)} 150 150)`
      );
      el.earR?.setAttribute(
        "transform",
        `rotate(${((twitch.ear === 1 ? twitchRot : 0) + shiver - perk).toFixed(2)} 330 150)`
      );

      // ---- brows: lift on loud syllables and while listening
      const browY = -(energy * 5) - (listening ? 2.5 : 0);
      el.browL?.setAttribute("transform", `translate(0 ${browY.toFixed(2)})`);
      el.browR?.setAttribute("transform", `translate(0 ${browY.toFixed(2)})`);

      // ---- gaze saccades (drift to a new nearby target every few seconds)
      if (now >= gaze.nextAt) {
        const range = speaking ? 2.2 : 5;
        gaze.tx = (Math.random() * 2 - 1) * range;
        gaze.ty = (Math.random() * 2 - 1) * range * 0.6;
        gaze.nextAt = now + 2400 + Math.random() * 2400;
      }
      gaze.x += (gaze.tx - gaze.x) * 0.12;
      gaze.y += (gaze.ty - gaze.y) * 0.12;
      el.irisL?.setAttribute("transform", `translate(${gaze.x.toFixed(2)} ${gaze.y.toFixed(2)})`);
      el.irisR?.setAttribute("transform", `translate(${gaze.x.toFixed(2)} ${gaze.y.toFixed(2)})`);

      // ---- blinks (140ms, sometimes double)
      let lid = 0; // 0 open … 48 closed
      if (blinkT >= 0) {
        const p = (now - blinkT) / 140;
        if (p >= 1) {
          if (doubleBlink) {
            doubleBlink = false;
            blinkT = now + 70;
          } else {
            blinkT = -1;
            blinkAt = now + 2200 + Math.random() * 3800;
          }
        } else if (p >= 0) {
          lid = Math.sin(Math.min(1, p) * Math.PI) * 48;
        }
      } else if (now >= blinkAt) {
        blinkT = now;
        doubleBlink = Math.random() < 0.12;
      }
      el.lidL?.setAttribute("transform", `translate(0 ${lid.toFixed(2)})`);
      el.lidR?.setAttribute("transform", `translate(0 ${lid.toFixed(2)})`);
    };
    raf = requestAnimationFrame(tick);
    // Watchdog: rAF stops in hidden tabs — keep the rig ticking (slowly) so
    // state stays sane and he's mid-motion, not frozen, when the tab returns.
    const watchdog = setInterval(() => {
      if (performance.now() - lastTick > 350) tick();
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 480 560"
      className={className}
      role="img"
      aria-label="The Car Fox — animated mascot"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id="foxBg" cx="38%" cy="28%" r="90%">
          <stop offset="0%" stopColor="#3388ea" />
          <stop offset="100%" stopColor="#0a55bb" />
        </radialGradient>
        <linearGradient id="foxFur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ef8332" />
          <stop offset="100%" stopColor="#d4681e" />
        </linearGradient>
        <radialGradient id="foxIris" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#c08238" />
          <stop offset="100%" stopColor="#7a4a1a" />
        </radialGradient>
        <clipPath id="foxMouthClip">
          <path data-fox="cavityClip" d="M -58 -6 C -29 -8, 29 -8, 58 -6 C 49 5, 17 6, 0 6 C -17 6, -49 5, -58 -6 Z" />
        </clipPath>
        <clipPath id="foxEyeClipL">
          <path d="M -32 2 Q -20 -22 6 -22 Q 30 -20 32 4 Q 26 24 -2 24 Q -26 22 -32 2 Z" transform="translate(183 242)" />
        </clipPath>
        <clipPath id="foxEyeClipR">
          <path d="M -32 2 Q -20 -22 6 -22 Q 30 -20 32 4 Q 26 24 -2 24 Q -26 22 -32 2 Z" transform="translate(297 242) scale(-1 1)" />
        </clipPath>
      </defs>

      <rect width="480" height="560" fill="url(#foxBg)" />

      {/* body: tee + chest ruff (breathes) */}
      <g data-fox="body">
        <path d="M 96 560 C 100 480 128 436 176 418 L 304 418 C 352 436 380 480 384 560 Z" fill="#f5f6f8" />
        <path d="M 176 418 Q 240 448 304 418" fill="none" stroke="#33383f" strokeWidth="9" strokeLinecap="round" />
        <text x="240" y="512" textAnchor="middle" fontFamily="'Arial Black', Arial, sans-serif" fontWeight="900" fontSize="44" fill="#23272d" letterSpacing="1">CAR</text>
        <text x="240" y="556" textAnchor="middle" fontFamily="'Arial Black', Arial, sans-serif" fontWeight="900" fontSize="44" fill="#23272d" letterSpacing="1">FOX</text>
        {/* solid neck fill so no background peeks between chin and shirt */}
        <ellipse cx="240" cy="404" rx="94" ry="54" fill="#f8f3ea" />
        <path
          d="M 150 424 L 172 392 L 194 420 L 217 388 L 240 418 L 263 388 L 286 420 L 308 392 L 330 424 C 322 450 280 462 240 462 C 200 462 158 450 150 424 Z"
          fill="#f8f3ea"
        />
      </g>

      {/* soft head shadow on the chest */}
      <ellipse cx="240" cy="408" rx="95" ry="15" fill="#000" opacity="0.12" />

      {/* head */}
      <g data-fox="head">
        {/* ears (roots tucked under the crown) */}
        <g data-fox="earL">
          <path d="M 100 34 C 136 20 174 60 188 126 C 192 148 178 162 156 156 C 126 148 100 118 92 76 C 88 54 90 40 100 34 Z" fill="#e07724" />
          <path d="M 112 52 C 134 46 158 76 168 122 C 170 136 162 144 148 140 C 126 132 108 106 104 76 C 102 62 104 54 112 52 Z" fill="#3a2313" />
        </g>
        <g data-fox="earR">
          <g transform="translate(480 0) scale(-1 1)">
            <path d="M 100 34 C 136 20 174 60 188 126 C 192 148 178 162 156 156 C 126 148 100 118 92 76 C 88 54 90 40 100 34 Z" fill="#e07724" />
            <path d="M 112 52 C 134 46 158 76 168 122 C 170 136 162 144 148 140 C 126 132 108 106 104 76 C 102 62 104 54 112 52 Z" fill="#3a2313" />
          </g>
        </g>

        {/* cheek fur spikes */}
        <path d="M 140 240 L 82 260 L 128 292 L 76 318 L 132 340 L 104 378 L 158 352 Z" fill="#d2661f" />
        <path d="M 340 240 L 398 260 L 352 292 L 404 318 L 348 340 L 376 378 L 322 352 Z" fill="#d2661f" />

        {/* head base */}
        <path
          d="M 240 118 C 172 118 118 168 112 232 C 108 272 128 306 160 336 C 190 366 216 392 240 396 C 264 392 290 366 320 336 C 352 306 372 272 368 232 C 362 168 308 118 240 118 Z"
          fill="url(#foxFur)"
        />

        {/* brows */}
        <g data-fox="browL">
          <path d="M 155 208 Q 185 192 215 204" fill="none" stroke="#6b3a10" strokeWidth="13" strokeLinecap="round" />
        </g>
        <g data-fox="browR">
          <path d="M 265 204 Q 295 192 325 208" fill="none" stroke="#6b3a10" strokeWidth="13" strokeLinecap="round" />
        </g>

        {/* eyes */}
        <g>
          <path d="M -32 2 Q -20 -22 6 -22 Q 30 -20 32 4 Q 26 24 -2 24 Q -26 22 -32 2 Z" transform="translate(183 242)" fill="#fdfcf8" stroke="#c96a20" strokeWidth="2" />
          <g clipPath="url(#foxEyeClipL)">
            <g data-fox="irisL">
              <circle cx="187" cy="243" r="13.5" fill="url(#foxIris)" />
              <circle cx="187" cy="243" r="6.5" fill="#140b05" />
              <circle cx="184" cy="239" r="2.8" fill="#fff" />
              <circle cx="192" cy="247" r="1.4" fill="#fff" opacity="0.8" />
            </g>
            <g data-fox="lidL">
              <rect x="147" y="155" width="72" height="64" fill="#e8802f" />
            </g>
          </g>
          <path d="M -32 2 Q -20 -22 6 -22 Q 30 -20 32 4 Q 26 24 -2 24 Q -26 22 -32 2 Z" transform="translate(297 242) scale(-1 1)" fill="#fdfcf8" stroke="#c96a20" strokeWidth="2" />
          <g clipPath="url(#foxEyeClipR)">
            <g data-fox="irisR">
              <circle cx="293" cy="243" r="13.5" fill="url(#foxIris)" />
              <circle cx="293" cy="243" r="6.5" fill="#140b05" />
              <circle cx="290" cy="239" r="2.8" fill="#fff" />
              <circle cx="298" cy="247" r="1.4" fill="#fff" opacity="0.8" />
            </g>
            <g data-fox="lidR">
              <rect x="261" y="155" width="72" height="64" fill="#e8802f" />
            </g>
          </g>
        </g>

        {/* muzzle */}
        <ellipse cx="206" cy="318" rx="56" ry="44" fill="#fbf6ee" />
        <ellipse cx="274" cy="318" rx="56" ry="44" fill="#fbf6ee" />
        <ellipse cx="240" cy="346" rx="52" ry="36" fill="#fbf6ee" />
        <circle cx="176" cy="322" r="2" fill="#d9b48c" />
        <circle cx="188" cy="336" r="2" fill="#d9b48c" />
        <circle cx="172" cy="340" r="2" fill="#d9b48c" />
        <circle cx="304" cy="322" r="2" fill="#d9b48c" />
        <circle cx="292" cy="336" r="2" fill="#d9b48c" />
        <circle cx="308" cy="340" r="2" fill="#d9b48c" />

        {/* nose */}
        <path d="M 240 270 C 254 270 262 278 258 288 C 254 297 246 302 240 302 C 234 302 226 297 222 288 C 218 278 226 270 240 270 Z" fill="#241611" />
        <ellipse cx="233" cy="279" rx="5" ry="3.5" fill="#fff" opacity="0.25" transform="rotate(-15 233 279)" />

        {/* mouth — parametric, rebuilt every frame */}
        <g transform="translate(240 344)">
          <path data-fox="cavity" d="" fill="#391b0e" stroke="#7c4515" strokeWidth="4" strokeLinejoin="round" opacity="0" />
          <ellipse data-fox="tongue" cx="0" cy="30" rx="30" ry="10" fill="#e2606b" clipPath="url(#foxMouthClip)" opacity="0" />
          <path data-fox="teeth" d="" fill="#fff" clipPath="url(#foxMouthClip)" opacity="0" />
          <path data-fox="lip" d="M -58 -6 C -29 4, 29 4, 58 -6" fill="none" stroke="#7c4515" strokeWidth="5" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
