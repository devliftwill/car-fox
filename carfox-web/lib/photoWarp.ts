/**
 * photoWarp — tiny 2D-canvas mesh warper for photo animation.
 *
 * A rectangular grid is laid over a region of the source image; each vertex
 * gets a displacement from a caller-supplied field; each grid cell renders as
 * two texture-mapped triangles (affine transform + clip + drawImage). Cells
 * whose vertices barely move are skipped entirely — the un-warped base image
 * is already showing the right pixels there — so idle frames cost ~nothing.
 *
 * This is how the photo's OWN lips, chin, and eyelids move: no painted
 * overlays, just the photograph's pixels displaced smoothly.
 */

export type Vec = { x: number; y: number };
export type DisplaceFn = (x: number, y: number) => Vec;

/** Affine-map the source triangle onto the destination triangle. */
function drawTri(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  imgW: number,
  imgH: number,
  s0: Vec, s1: Vec, s2: Vec,
  d0: Vec, d1: Vec, d2: Vec
) {
  const den = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(den) < 1e-6) return;
  // Expand the destination triangle ~3% from its centroid so adjacent
  // triangles overlap by a hair — hides antialiasing cracks along edges.
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p: Vec): Vec => ({ x: p.x + (p.x - cx) * 0.03, y: p.y + (p.y - cy) * 0.03 });
  const e0 = grow(d0), e1 = grow(d1), e2 = grow(d2);

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e0.x, e0.y);
  ctx.lineTo(e1.x, e1.y);
  ctx.lineTo(e2.x, e2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0, imgW, imgH);
  ctx.restore();
}

/**
 * Warp `region` of the image with `displace`, drawing onto ctx (which should
 * already contain the un-warped base image).
 *
 * `rowOrder: "bottomFirst"` draws lower rows before upper ones so displaced
 * upper pixels overlap what's below — required for eyelids sliding DOWN over
 * the eyeball.
 */
export function drawWarpedGrid(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  imgW: number,
  imgH: number,
  region: { x0: number; y0: number; x1: number; y1: number },
  cols: number,
  rows: number,
  displace: DisplaceFn,
  rowOrder: "topFirst" | "bottomFirst" = "topFirst"
) {
  const { x0, y0, x1, y1 } = region;
  const cw = (x1 - x0) / cols;
  const ch = (y1 - y0) / rows;

  // Precompute vertex rest + displaced positions.
  const rest: Vec[][] = [];
  const disp: Vec[][] = [];
  for (let r = 0; r <= rows; r++) {
    rest[r] = [];
    disp[r] = [];
    for (let c = 0; c <= cols; c++) {
      const x = x0 + c * cw;
      const y = y0 + r * ch;
      const d = displace(x, y);
      rest[r][c] = { x, y };
      disp[r][c] = { x: x + d.x, y: y + d.y };
    }
  }

  const rowIdx = Array.from({ length: rows }, (_, i) => i);
  if (rowOrder === "bottomFirst") rowIdx.reverse();

  for (const r of rowIdx) {
    for (let c = 0; c < cols; c++) {
      const s00 = rest[r][c], s10 = rest[r][c + 1], s01 = rest[r + 1][c], s11 = rest[r + 1][c + 1];
      const d00 = disp[r][c], d10 = disp[r][c + 1], d01 = disp[r + 1][c], d11 = disp[r + 1][c + 1];
      // Skip cells that barely move — base image already shows them.
      const move =
        Math.abs(d00.x - s00.x) + Math.abs(d00.y - s00.y) +
        Math.abs(d10.x - s10.x) + Math.abs(d10.y - s10.y) +
        Math.abs(d01.x - s01.x) + Math.abs(d01.y - s01.y) +
        Math.abs(d11.x - s11.x) + Math.abs(d11.y - s11.y);
      if (move < 0.8) continue;
      drawTri(ctx, img, imgW, imgH, s00, s10, s01, d00, d10, d01);
      drawTri(ctx, img, imgW, imgH, s10, s11, s01, d10, d11, d01);
    }
  }
}

/** smoothstep 0→1 over [a,b] */
export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
