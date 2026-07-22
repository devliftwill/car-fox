/**
 * Shared parametric mouth — one geometry, two faces.
 *
 * Both the SVG fox (FoxAvatar) and the photo avatar (PhotoAvatar) build their
 * mouths from these path strings each frame, so a given open/round pair looks
 * identical no matter which face is talking. SVG consumes the strings as `d`
 * attributes; canvas consumes them via `new Path2D(str)`.
 *
 * Local coordinate space: mouth center at (0,0), closed width ≈ 116 units.
 */
export function mouthGeometry(open: number, round: number) {
  const hw = 14 + 44 * (1 - 0.52 * round) + 6 * open * (1 - round);
  const cornerY = -6 * (1 - open * 0.5);
  const topY = -4 - 3 * open;
  const botY = 6 + 52 * open * (1 + 0.1 * round);
  const cavity =
    `M ${-hw} ${cornerY}` +
    ` C ${-hw * 0.5} ${topY - 4}, ${hw * 0.5} ${topY - 4}, ${hw} ${cornerY}` +
    ` C ${hw * 0.85} ${botY * 0.85}, ${hw * 0.3} ${botY}, 0 ${botY}` +
    ` C ${-hw * 0.3} ${botY}, ${-hw * 0.85} ${botY * 0.85}, ${-hw} ${cornerY} Z`;
  const lip =
    `M ${-hw} ${cornerY}` +
    ` C ${-hw * 0.5} ${4 + open * 2}, ${hw * 0.5} ${4 + open * 2}, ${hw} ${cornerY}`;
  const teethTop = 0.75 * (topY - 4) + 0.25 * cornerY + 2;
  const teethH = Math.max(5, 9 + 6 * open - 11 * round * open);
  const tw = hw * 0.92;
  const teeth =
    `M ${-tw} ${teethTop} L ${tw} ${teethTop} L ${tw} ${teethTop + teethH}` +
    ` Q 0 ${teethTop + teethH + 4}, ${-tw} ${teethTop + teethH} Z`;
  return { cavity, lip, teeth, hw, botY };
}
