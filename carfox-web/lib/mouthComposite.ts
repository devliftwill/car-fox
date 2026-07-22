/**
 * mouthComposite — the viseme mouth, composited onto any source frame
 * (still photo or live video frame) at the rigged position.
 *
 * Mesh-warps the source's own jaw/lip pixels open (lib/photoWarp), then
 * reveals a cavity shaped by the face's real inner-lip contour with a slim
 * teeth peek. Shared verbatim by PhotoAvatar and VideoAvatar so a given
 * open/round pair looks identical on both.
 */
import { drawWarpedGrid, smooth, type Vec } from "./photoWarp";
import type { AvatarRig } from "./avatarStore";

/** Synthesized inner-lip lens for manual rigs (no detected contours). */
function synthLens(halfW: number): { top: Vec[]; bottom: Vec[] } {
  const n = 11;
  const top: Vec[] = [];
  const bottom: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = (t * 2 - 1) * halfW * 0.72;
    const bump = Math.sin(Math.acos(Math.min(1, Math.abs(t * 2 - 1))));
    top.push({ x: -u, y: -bump * halfW * 0.05 });
    bottom.push({ x: u, y: bump * halfW * 0.09 });
  }
  return { top, bottom };
}

export function drawMouthComposite(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  W: number,
  H: number,
  rig: AvatarRig,
  open: number,
  round: number,
  dbg?: Record<string, unknown>
) {
  if (open <= 0.02) return;

  const mx = rig.mouth.x * W;
  const my = rig.mouth.y * H;
  const halfW = (rig.mouth.w * W) / 2;
  const ang = rig.mouth.angle;
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  const drop = open * halfW * 0.62;
  const raise = drop * 0.14;
  const pull = round * halfW * 0.2;

  // Anchor the vertical profile at the ACTUAL lip seam (pins can sit a few
  // px off it, which would park the ramp's dead zone on the lower lip).
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

  const displace = (x: number, y: number): Vec => {
    const rx = x - mx, ry = y - my;
    const u = rx * cosA + ry * sinA;
    const v = -rx * sinA + ry * cosA - seamV;
    const gx = 1 - smooth(halfW * 0.9, halfW * 2.1, Math.abs(u));
    const jawFac = smooth(-halfW * 0.01, halfW * 0.06, v) * (1 - smooth(halfW * 1.7, halfW * 2.5, v));
    const upFac = smooth(-halfW * 0.9, -halfW * 0.12, v) * (1 - smooth(-halfW * 0.12, halfW * 0.06, v));
    const dv = drop * gx * jawFac - raise * gx * upFac;
    const cornerFac = smooth(halfW * 0.25, halfW * 0.95, Math.abs(u)) * (1 - smooth(halfW * 1.1, halfW * 1.8, Math.abs(u)));
    const lipBand = 1 - smooth(halfW * 0.15, halfW * 0.8, Math.abs(v));
    const du = -Math.sign(u) * pull * cornerFac * lipBand;
    return { x: du * cosA - dv * sinA, y: du * sinA + dv * cosA };
  };

  // 1) mesh-warp the jaw region of the source
  drawWarpedGrid(
    ctx, source, W, H,
    { x0: mx - halfW * 2.4, y0: my - halfW * 1.2, x1: mx + halfW * 2.4, y1: my + halfW * 2.8 },
    12, 10, displace
  );

  // 2) cavity from the face's own inner-lip contour (or synthesized lens)
  let topArc: Vec[], bottomArc: Vec[];
  if (rig.contours) {
    topArc = rig.contours.lipInnerTop.map((p) => ({ x: p.x * W, y: p.y * H }));
    bottomArc = rig.contours.lipInnerBottom.map((p) => ({ x: p.x * W, y: p.y * H }));
  } else {
    const lens = synthLens(halfW);
    const toImg = (p: Vec): Vec => ({ x: mx + p.x * cosA - p.y * sinA, y: my + p.x * sinA + p.y * cosA });
    topArc = lens.top.map(toImg);
    bottomArc = lens.bottom.map(toImg);
  }
  const dTop = topArc.map((p) => {
    const d = displace(p.x, p.y);
    return { x: p.x + d.x, y: p.y + d.y };
  });
  // Bottom inner lip rides the jaw explicitly — at rest it coincides with the
  // seam, where any vertical field is zero by construction.
  const nB = bottomArc.length - 1;
  const dBot = bottomArc.map((p, i) => {
    const wArc = Math.pow(Math.sin((Math.PI * i) / nB), 0.8);
    const dv = drop * 0.92 * wArc;
    const d = displace(p.x, p.y);
    return { x: p.x + d.x - sinA * dv, y: p.y + cosA * dv };
  });

  const gap = Math.hypot(dBot[5].x - dTop[5].x, dBot[5].y - dTop[5].y);
  if (dbg) {
    dbg.gap = gap;
    dbg.drew = "warp";
  }
  if (gap <= halfW * 0.06) return;
  if (dbg) dbg.drew = "cavity";

  const cavity = new Path2D();
  cavity.moveTo(dBot[0].x, dBot[0].y);
  for (let i = 1; i < dBot.length; i++) cavity.lineTo(dBot[i].x, dBot[i].y);
  for (let i = 1; i < dTop.length; i++) cavity.lineTo(dTop[i].x, dTop[i].y);
  cavity.closePath();

  const grad = ctx.createLinearGradient(
    mx - sinA * halfW, my - cosA * halfW * 0.3,
    mx + sinA * halfW, my + cosA * halfW * 1.2
  );
  grad.addColorStop(0, "#3d1b12");
  grad.addColorStop(1, "#160a06");
  ctx.fillStyle = grad;
  ctx.fill(cavity);

  // slim upper-teeth peek (round vowels hide them)
  if (open > 0.22) {
    const teethH = Math.min(drop * 0.3, halfW * 0.15) * (1 - round * 0.45);
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
