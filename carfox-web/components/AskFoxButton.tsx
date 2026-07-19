"use client";

/**
 * CTA that opens the site-wide fox dock (lower-right) instead of navigating.
 * FoxWidget listens for the "carfox:open" event; on vehicle pages it already
 * derives the car from the URL, so the call starts knowing that vehicle.
 */
export default function AskFoxButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event("carfox:open"))}
    >
      {children}
    </button>
  );
}
