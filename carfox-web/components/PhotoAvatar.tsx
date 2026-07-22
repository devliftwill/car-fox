"use client";

/**
 * PhotoAvatar v2 — realism pass. The photo's OWN pixels do the talking:
 *
 *  - Jaw & lips: a mesh warp (lib/photoWarp) displaces the chin/lower-lip
 *    region downward with `open` and pulls the corners in with `round`, so
 *    the person's actual mouth stretches open — no painted cartoon mouth.
 *  - Inner mouth: revealed only inside the person's own inner-lip contour
 *    (captured by MediaPipe at rig time, warped consistently with the mesh),
 *    with a subtle upper-teeth band. Manual rigs get a synthesized lens.
 *  - Blinks: the upper-eyelid skin is mesh-warped down over the eyeball
 *    (drawn bottom-row-first so the lid overlaps the eye) — real skin
 *    texture, not painted ellipses.
 *  - Whole-head micro-motion: bob / sway / breathing.
 *
 * Driven by the same `sample()` viseme params as the SVG fox.
 */
import { useEffect, useRef } from "react";
import type { FoxSample } from "./FoxAvatar";
import { drawWarpedGrid, smooth, type Vec } from "@/lib/photoWarp";
import type { AvatarConfig, Pt } from "@/lib/avatarStore";

/** Synthesized inner-lip lens for manual rigs (no detected contours). */
function synthLens(halfW: number): { top: Vec[]; bottom: Vec[] } {
  const n = 11;
  const top: Vec[] = [];
  const bottom: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0..1
    const u = (t * 2 - 1) * halfW * 0.72;
    const bump = Math.sin(Math.acos(Math.min(1, Math.abs(t * 2 - 1)))); // half-ellipse
    // top runs right→left, bottom left→right (matching detected ordering)
    top.push({ x: -u, y: -bump * halfW * 0.05 });
    bottom.push({ x: u, y: bump * halfW * 0.09 });
  }
  return { top, bottom };
}

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

    // Animation state
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

      // ------- mouth & jaw warp -------
      const mx = rig.mouth.x * W;
      const my = rig.mouth.y * H;
      const halfW = (rig.mouth.w * W) / 2;
      const ang = rig.mouth.angle;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const drop = mouth.open * halfW * 0.62;
      const raise = drop * 0.14;
      const pull = mouth.round * halfW * 0.2;

      // The jaw ramp must start at the ACTUAL lip seam, not the pin line —
      // mouth-corner pins often sit a few px below the seam, which parked the
      // lower lip in the ramp's dead zone (chin moved, lips barely parted).
      let seamV = 0;
      if (rig.contours) {
        let sum = 0, n = 0;
        for (const arr of [rig.contours.lipInnerTop, rig.contours.lipInnerBottom]) {
          for (const p of arr) {
            const rx = p.x * W - mx, ry = p.y * H - my;
            sum += -rx * sinA + ry * cosA;
            n++;
          }
        }
        if (n) seamV = sum / n;
      }

      const mouthDisplace = (x: number, y: number): Vec => {
        // mouth-local frame (u across lips, v down from the lip seam)
        const rx = x - mx, ry = y - my;
        const u = rx * cosA + ry * sinA;
        const v = -rx * sinA + ry * cosA - seamV;
        const gx = 1 - smooth(halfW * 0.9, halfW * 2.1, Math.abs(u));
        // Tight ramp: everything ≥2px below the seam rides the jaw almost
        // rigidly, so the stretch "smear" collapses to a couple of px that
        // the cavity polygon then covers.
        const jawFac = smooth(-halfW * 0.01, halfW * 0.06, v) * (1 - smooth(halfW * 1.7, halfW * 2.5, v));
        const upFac = smooth(-halfW * 0.9, -halfW * 0.12, v) * (1 - smooth(-halfW * 0.12, halfW * 0.06, v));
        const dv = drop * gx * jawFac - raise * gx * upFac;
        const cornerFac = smooth(halfW * 0.25, halfW * 0.95, Math.abs(u)) * (1 - smooth(halfW * 1.1, halfW * 1.8, Math.abs(u)));
        const lipBand = 1 - smooth(halfW * 0.15, halfW * 0.8, Math.abs(v));
        const du = -Math.sign(u) * pull * cornerFac * lipBand;
        return { x: du * cosA - dv * sinA, y: du * sinA + dv * cosA };
      };

      const dbg: Record<string, unknown> = { open: mouth.open, sampled: !!m, halfW, drop, drew: "none" };
      if (debugTag) {
        const w = window as unknown as { __paDbg?: Record<string, unknown> };
        w.__paDbg = w.__paDbg || {};
        w.__paDbg[debugTag] = dbg;
      }

      if (mouth.open > 0.02) {
        // inner-mouth cavity FIRST in z-order terms: we draw base image, then
        // warped mesh (stretched lip pixels), then cavity on top of the smear.
        drawWarpedGrid(
          ctx, img, W, H,
          { x0: mx - halfW * 2.4, y0: my - halfW * 1.2, x1: mx + halfW * 2.4, y1: my + halfW * 2.8 },
          12, 10, mouthDisplace
        );

        // contours in px (detected) or synthesized lens (manual rig)
        let topArc: Vec[], bottomArc: Vec[];
        if (rig.contours) {
          topArc = rig.contours.lipInnerTop.map((p: Pt) => ({ x: p.x * W, y: p.y * H }));
          bottomArc = rig.contours.lipInnerBottom.map((p: Pt) => ({ x: p.x * W, y: p.y * H }));
        } else {
          const lens = synthLens(halfW);
          const toImg = (p: Vec): Vec => ({ x: mx + p.x * cosA - p.y * sinA, y: my + p.x * sinA + p.y * cosA });
          topArc = lens.top.map(toImg);
          bottomArc = lens.bottom.map(toImg);
        }
        const dTop = topArc.map((p) => { const d = mouthDisplace(p.x, p.y); return { x: p.x + d.x, y: p.y + d.y }; });
        // The bottom inner lip IS the lower lip — at rest it coincides with
        // the seam, where any vertical field is ~zero by construction. Drop
        // it explicitly, tapered corner→center into a natural lens (the
        // field still contributes the corner-pull in x).
        const nB = bottomArc.length - 1;
        const dBot = bottomArc.map((p, i) => {
          const wArc = Math.pow(Math.sin((Math.PI * i) / nB), 0.8);
          const dv = drop * 0.92 * wArc;
          const d = mouthDisplace(p.x, p.y);
          return { x: p.x + d.x - sinA * dv, y: p.y + cosA * dv };
        });

        // open enough to see inside?
        const gap = Math.hypot(dBot[5].x - dTop[5].x, dBot[5].y - dTop[5].y);
        dbg.gap = gap;
        dbg.gapMin = halfW * 0.06;
        dbg.topMid = dTop[5];
        dbg.botMid = dBot[5];
        if (gap > halfW * 0.06) {
          dbg.drew = "cavity";
          const cavity = new Path2D();
          cavity.moveTo(dBot[0].x, dBot[0].y);
          for (let i = 1; i < dBot.length; i++) cavity.lineTo(dBot[i].x, dBot[i].y);
          for (let i = 1; i < dTop.length; i++) cavity.lineTo(dTop[i].x, dTop[i].y);
          cavity.closePath();

          const grad = ctx.createLinearGradient(mx - sinA * halfW, my - cosA * halfW * 0.3, mx + sinA * halfW, my + cosA * halfW * 1.2);
          grad.addColorStop(0, "#3d1b12");
          grad.addColorStop(1, "#160a06");
          ctx.fillStyle = grad;
          ctx.fill(cavity);

          // upper teeth — attached to the (slightly raised) top lip contour;
          // a narrow peek reads natural, a tall band reads like dentures
          if (mouth.open > 0.22) {
            const teethH = Math.min(drop * 0.3, halfW * 0.15) * (1 - mouth.round * 0.45);
            const ox = -sinA * teethH, oy = cosA * teethH;
            ctx.save();
            ctx.clip(cavity);
            const teeth = new Path2D();
            teeth.moveTo(dTop[dTop.length - 1].x, dTop[dTop.length - 1].y);
            for (let i = dTop.length - 2; i >= 0; i--) teeth.lineTo(dTop[i].x, dTop[i].y);
            for (let i = 0; i < dTop.length; i++) teeth.lineTo(dTop[i].x + ox, dTop[i].y + oy);
            teeth.closePath();
            ctx.fillStyle = "rgba(228, 219, 205, 0.96)";
            ctx.fill(teeth);
            // soft shadow under the teeth edge
            ctx.strokeStyle = "rgba(0,0,0,0.18)";
            ctx.lineWidth = Math.max(1, halfW * 0.03);
            ctx.beginPath();
            ctx.moveTo(dTop[dTop.length - 1].x + ox, dTop[dTop.length - 1].y + oy);
            for (let i = dTop.length - 2; i >= 0; i--) ctx.lineTo(dTop[i].x + ox, dTop[i].y + oy);
            ctx.stroke();
            ctx.restore();
          }
          // soft lip shadow around the opening
          ctx.strokeStyle = "rgba(30, 10, 6, 0.35)";
          ctx.lineWidth = Math.max(1, halfW * 0.035);
          ctx.stroke(cavity);
        }
      }

      // ------- blinks: upper-lid skin warped down over the eye -------
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
  }, []); // config changes remount via key upstream

  return <canvas ref={canvasRef} className={className} aria-label="Custom talking avatar" role="img" />;
}
