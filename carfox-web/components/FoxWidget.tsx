"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import FoxRoomCall from "./FoxRoomCall";

/**
 * Site-wide Car Fox dock — the Gemini-powered fox on every page.
 *
 * Collapsed: a floating fox button in the lower-right.
 * Open: a compact live-call panel (FoxRoomCall autostarts the sidecar).
 * Page-aware: on /vehicles/[slug] the fox starts the call already knowing
 * that exact car (VIN, price, CARFAX history) via the bot's --vehicle flag.
 * Closing the panel unmounts the call → bot killed → LemonSlice session
 * ended → credit meter stopped.
 */
export default function FoxWidget() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Pre-warm the fox daemon on page load (free — no LemonSlice session yet),
  // so clicking the fox skips the Python boot entirely.
  useEffect(() => {
    fetch("/api/fox-room?warm=1").catch(() => {});
  }, []);

  // /live hosts the full-size fox experience already.
  if (pathname?.startsWith("/live")) return null;

  // The passcode gate is pre-login — no fox until you're inside.
  if (pathname === "/gate") return null;

  const vehicleSlug = pathname?.startsWith("/vehicles/")
    ? pathname.split("/")[2]
    : undefined;

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fox-dock-btn"
          aria-label="Talk to the Car Fox — start a live conversation"
        >
          <span className="fox-dock-rings">
            <span />
            <span />
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/carfox-avatar.png" alt="Car Fox" />
          <span className="fox-dock-label">
            {vehicleSlug ? "Ask the Fox about this car" : "Talk to the Fox"}
          </span>
        </button>
      )}
      {open && (
        <div className="fox-dock-panel">
          <div className="fox-dock-head">
            <b>
              Car Fox <span style={{ color: "var(--fox)" }}>Live</span>
            </b>
            <button onClick={() => setOpen(false)} aria-label="End call and close">
              ✕
            </button>
          </div>
          <div className="fox-dock-body">
            <FoxRoomCall key={pathname} vehicleSlug={vehicleSlug} compact autoStart />
          </div>
        </div>
      )}
    </>
  );
}
