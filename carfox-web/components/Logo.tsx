/**
 * Brand logo — official CARFAX Canada mark (public/carfax-logo.svg).
 * The artwork is self-contained (white letters knocked out of black tiles +
 * red star), so it reads on both the dark video hero and white surfaces
 * without recoloring. `height` sets the render size; aspect ratio is fixed.
 */
export default function Logo({
  height = 22,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/carfax-logo.svg"
      alt="CARFAX Canada"
      height={height}
      style={{ height, width: "auto" }}
      className={`block ${className}`}
    />
  );
}
