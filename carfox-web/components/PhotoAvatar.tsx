"use client";

/**
 * PhotoAvatar — a still photo brought to life client-side: the shared
 * mouthComposite mesh-warps the photo's own jaw/lips per viseme, blinks warp
 * the eyelid skin down over the eye, and the whole head gets micro-motion
 * (bob / sway / breathing) since a still has none of its own.
 *
 * (The video-based sibling is VideoAvatar — real footage, pre-tracked.)
 * Driven by the same `sample()` params as the SVG fox.
 */
import { useEffect, useRef } from "react";
import type { FoxSample } from "./FoxAvatar";
import { drawWarpedGrid, smooth, type Vec } from "@/lib/photoWarp";
import { drawMouthComposite } from "@/lib/mouthComposite";
import type { AvatarConfig } from "@/lib/avatarStore";

export default function PhotoAvatar({
  config,
  sample,
  className,
  debugTag,
}: {
  config: AvatarConfig;
  sample?: () => FoxSample;
  className?: string;
  /** Dev: expose per-frame internals at window.__paDbg[debugTag]. */
  debugTag?: string;
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
    const cfg0 = cfgRef.current;
    if (!cfg0.image) return;
    const W = cfg0.w, H = cfg0.h;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const img = new Image();
    img.src = cfg0.image;
    let bgColor = "#101418";
    let ready = false;
    img.onload = () => {
      try {
        const probe = document.createElement("canvas");
        probe.width = W;
        probe.height = H;
        const pctx = probe.getContext("2d")!;
        pctx.drawImage(img, 0, 0, W, H);
        const border = pctx.getImageData(0, 0, W, Math.max(2, Math.round(H * 0.04)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < border.data.length; i += 4) {
          if (border.data[i + 3] < 200) continue;
          r += border.data[i]; g += border.data[i + 1]; b += border.data[i + 2]; n++;
        }
        if (n) bgColor = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
      } catch {}
      ready = true;
    };

    let raf = 0;
    let lastTick = 0;
    let blinkAt = performance.now() + 1400 + Math.random() * 2400;
    let blinkT = -1;
    let doubleBlink = false;
    const mouth = { open: 0, round: 0 };

    const tick = () => {
      lastTick = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (!ready) return;
      const cfg = cfgRef.current;
      const rig = cfg.rig;
      const now = performance.now();
      const t = now / 1000;
      const s: FoxSample = sampleRef.current?.() ?? { mouth: null };
      const m = s.mouth;
      const energy = m?.energy ?? 0;

      mouth.open += ((m ? m.open : 0) - mouth.open) * 0.5;
      mouth.round += ((m ? m.round : mouth.round * 0.9) - mouth.round) * 0.35;

      // blink scheduler
      let blink = 0;
      if (blinkT >= 0) {
        const p = (now - blinkT) / 150;
        if (p >= 1) {
          if (doubleBlink) { doubleBlink = false; blinkT = now + 80; }
          else { blinkT = -1; blinkAt = now + 2400 + Math.random() * 3800; }
        } else if (p >= 0) {
          blink = Math.sin(Math.min(1, p) * Math.PI);
        }
      } else if (now >= blinkAt) {
        blinkT = now;
        doubleBlink = Math.random() < 0.1;
      }

      const sway = reduceMotion ? 0 : 1;
      const bobY = sway * (Math.sin(t * 1.4) * H * 0.004 + energy * Math.sin(t * 11) * H * 0.006);
      const rotDeg = sway * (Math.sin(t * 0.6) * 0.6 + energy * Math.sin(t * 7.3) * 0.9);
      const breath = 1.04 + (reduceMotion ? 0 : 0.005 * Math.sin(t * 1.1));

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(W / 2, H);
      ctx.rotate((rotDeg * Math.PI) / 180);
      ctx.scale(breath, breath);
      ctx.translate(-W / 2, -H);
      ctx.translate(0, bobY);

      ctx.drawImage(img, 0, 0, W, H);

      // viseme mouth (shared with VideoAvatar)
      const dbg: Record<string, unknown> = { open: mouth.open, sampled: !!m, drew: "none" };
      drawMouthComposite(ctx, img, W, H, rig, mouth.open, mouth.round, debugTag ? dbg : undefined);
      if (debugTag) {
        const w = window as unknown as { __paDbg?: Record<string, unknown> };
        w.__paDbg = w.__paDbg || {};
        w.__paDbg[debugTag] = dbg;
      }

      // blinks: upper-lid skin warped down over the eye
      if (blink > 0.05) {
        for (const eye of [rig.eyeL, rig.eyeR]) {
          const ex = eye.x * W, ey = eye.y * H, er = eye.r * W;
          const lidDrop = blink * er * 1.5;
          const upperLidY = ey - er * 0.55;
          const lidDisplace = (x: number, y: number): Vec => {
            const gx = 1 - smooth(er * 1.1, er * 2.0, Math.abs(x - ex));
            const ramp = smooth(ey - er * 2.4, ey - er * 1.3, y);
            const fade = 1 - smooth(upperLidY, ey + er * 0.5, y);
            return { x: 0, y: lidDrop * gx * Math.min(ramp, fade) };
          };
          drawWarpedGrid(
            ctx, img, W, H,
            { x0: ex - er * 2.1, y0: ey - er * 2.6, x1: ex + er * 2.1, y1: ey + er * 1.6 },
            8, 8, lidDisplace, "bottomFirst"
          );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debugTag is a dev-only constant; config changes remount via key upstream
  }, []);

  return <canvas ref={canvasRef} className={className} aria-label="Custom talking avatar" role="img" />;
}
