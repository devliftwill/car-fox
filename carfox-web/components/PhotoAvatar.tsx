"use client";

/**
 * PhotoAvatar — turns any uploaded photo into a live talking head, entirely
 * on canvas, no servers.
 *
 * The trick is a classic animated-cutout: the photo stays intact except at
 * the rigged mouth, where three layers composite each frame —
 *
 *   1. the mouth cavity (dark interior + teeth + tongue) painted over the
 *      lip line, built from the SAME parametric mouthGeometry() the SVG fox
 *      uses, so visemes look identical across faces;
 *   2. a "jaw" cutout of the photo (lower lip + chin) that slides down as
 *      the mouth opens, revealing the cavity — the JibJab effect;
 *   3. eyelid ellipses in locally-sampled skin tones for blinks.
 *
 * Plus head bob/sway/breathing on the whole image. Driven by the same
 * `sample()` params as FoxAvatar (FoxLipsync in a live call).
 */
import { useEffect, useRef } from "react";
import type { FoxSample } from "./FoxAvatar";
import { mouthGeometry } from "@/lib/foxMouth";
import type { AvatarConfig } from "@/lib/avatarStore";

const MOUTH_UNITS = 116; // closed-mouth width of mouthGeometry's local space

/** Average color of a pixel region, skipping transparent pixels. */
function sampleColor(data: ImageData, fallback: string): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i + 3] < 200) continue;
    r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; n++;
  }
  if (!n) return fallback;
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

export default function PhotoAvatar({
  config,
  sample,
  className,
}: {
  config: AvatarConfig;
  sample?: () => FoxSample;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef(sample);
  useEffect(() => {
    sampleRef.current = sample;
  });
  const cfgRef = useRef(config);
  useEffect(() => {
    cfgRef.current = config;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = cfgRef.current;
    const W = cfg.w, H = cfg.h;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const img = new Image();
    img.src = cfg.image;

    // Colors sampled once the photo decodes: background from the border,
    // eyelids from a patch just above each eye (≈ the skin that would cover it).
    let bgColor = "#0d55b5";
    let lidL = "#caa88a", lidR = "#caa88a";
    let ready = false;
    img.onload = () => {
      try {
        const probe = document.createElement("canvas");
        probe.width = W; probe.height = H;
        const pctx = probe.getContext("2d")!;
        pctx.drawImage(img, 0, 0, W, H);
        const border = pctx.getImageData(0, 0, W, Math.max(2, Math.round(H * 0.04)));
        bgColor = sampleColor(border, bgColor);
        const eyePatch = (ex: number, ey: number, er: number) => {
          const px = Math.round(ex * W - er * W);
          const py = Math.round(ey * H - er * W * 2.2);
          const pw = Math.max(2, Math.round(er * W * 2));
          const ph = Math.max(2, Math.round(er * W * 0.8));
          return sampleColor(
            pctx.getImageData(
              Math.max(0, Math.min(W - pw, px)),
              Math.max(0, Math.min(H - ph, py)),
              pw, ph
            ),
            "#caa88a"
          );
        };
        lidL = eyePatch(cfg.rig.eyeL.x, cfg.rig.eyeL.y, cfg.rig.eyeL.r);
        lidR = eyePatch(cfg.rig.eyeR.x, cfg.rig.eyeR.y, cfg.rig.eyeR.r);
      } catch {
        // canvas tainted or probe failure — defaults are fine
      }
      ready = true;
    };

    // Animation state
    let raf = 0;
    let lastTick = 0;
    let blinkAt = performance.now() + 1200 + Math.random() * 2200;
    let blinkT = -1;
    let doubleBlink = false;
    const mouth = { open: 0, round: 0 };

    const tick = () => {
      lastTick = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (!ready) return;
      const now = performance.now();
      const t = now / 1000;
      const s: FoxSample = sampleRef.current?.() ?? { mouth: null };
      const m = s.mouth;
      const energy = m?.energy ?? 0;

      const openT = m ? m.open : 0;
      const roundT = m ? m.round : mouth.round * 0.9;
      mouth.open += (openT - mouth.open) * 0.5;
      mouth.round += (roundT - mouth.round) * 0.35;

      // blink scheduler (same feel as the fox)
      let lid = 0;
      if (blinkT >= 0) {
        const p = (now - blinkT) / 140;
        if (p >= 1) {
          if (doubleBlink) { doubleBlink = false; blinkT = now + 70; }
          else { blinkT = -1; blinkAt = now + 2200 + Math.random() * 3800; }
        } else if (p >= 0) {
          lid = Math.sin(Math.min(1, p) * Math.PI);
        }
      } else if (now >= blinkAt) {
        blinkT = now;
        doubleBlink = Math.random() < 0.12;
      }

      const sway = reduceMotion ? 0 : 1;
      const bobY = sway * (Math.sin(t * 1.4) * H * 0.006 + energy * Math.sin(t * 11) * H * 0.008);
      const rotDeg = sway * (Math.sin(t * 0.6) * 0.8 + energy * Math.sin(t * 7.3) * 1.2);
      const breath = 1.045 + (reduceMotion ? 0 : 0.006 * Math.sin(t * 1.1));

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      // head pivot at bottom-center; slight overscale hides rotated edges
      ctx.translate(W / 2, H);
      ctx.rotate((rotDeg * Math.PI) / 180);
      ctx.scale(breath, breath);
      ctx.translate(-W / 2, -H);
      ctx.translate(0, bobY);

      ctx.drawImage(img, 0, 0, W, H);

      const rig = cfgRef.current.rig;
      const mx = rig.mouth.x * W;
      const my = rig.mouth.y * H;
      const scale = (rig.mouth.w * W) / MOUTH_UNITS;
      const mtx = new DOMMatrix()
        .translateSelf(mx, my)
        .rotateSelf((rig.mouth.angle * 180) / Math.PI)
        .scaleSelf(scale, scale);

      if (mouth.open > 0.035) {
        const g = mouthGeometry(mouth.open, mouth.round);
        const cavity = new Path2D();
        cavity.addPath(new Path2D(g.cavity), mtx);

        // 1) cavity interior
        ctx.fillStyle = "#2b120c";
        ctx.fill(cavity);
        // teeth + tongue, clipped inside the cavity
        ctx.save();
        ctx.clip(cavity);
        const teeth = new Path2D();
        teeth.addPath(new Path2D(g.teeth), mtx);
        ctx.fillStyle = "#f3efe6";
        ctx.fill(teeth);
        if (mouth.open > 0.2) {
          const tongue = new Path2D();
          const tl = new Path2D();
          tl.ellipse(0, g.botY - 8, g.hw * 0.6, 6 + 16 * mouth.open, 0, 0, Math.PI * 2);
          tongue.addPath(tl, mtx);
          ctx.fillStyle = "#d8535f";
          ctx.fill(tongue);
        }
        ctx.restore();
        // soft lip edge around the cavity
        ctx.strokeStyle = "rgba(43,18,12,0.55)";
        ctx.lineWidth = Math.max(1.5, scale * 2.5);
        ctx.stroke(cavity);

        // 2) jaw cutout — photo's lower lip + chin slides down with `open`
        const jawHw = 78, jawH = 92;
        const jawLocal = new Path2D(
          `M ${-jawHw} 2 Q 0 ${2 + jawHw * 0.24} ${jawHw} 2 ` +
            `Q ${jawHw * 1.06} ${jawH * 0.6} 0 ${jawH} ` +
            `Q ${-jawHw * 1.06} ${jawH * 0.6} ${-jawHw} 2 Z`
        );
        const jaw = new Path2D();
        jaw.addPath(jawLocal, mtx);
        const dropPx = mouth.open * 30 * scale;
        const a = rig.mouth.angle;
        ctx.save();
        ctx.clip(jaw);
        ctx.translate(-Math.sin(a) * dropPx, Math.cos(a) * dropPx);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.restore();
      }

      // 3) blinks
      if (lid > 0.06) {
        for (const [eye, color] of [
          [rig.eyeL, lidL],
          [rig.eyeR, lidR],
        ] as const) {
          const ex = eye.x * W, ey = eye.y * H, er = eye.r * W;
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(ex, ey, er * 1.5, Math.max(0.5, er * 1.15 * lid), 0, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.restore();
        }
      }

      ctx.restore();
    };

    raf = requestAnimationFrame(tick);
    const watchdog = setInterval(() => {
      if (performance.now() - lastTick > 350) tick();
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
    };
  }, []); // config changes remount via key upstream

  return <canvas ref={canvasRef} className={className} aria-label="Custom talking avatar" role="img" />;
}
