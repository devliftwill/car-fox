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
 *
 * TEMPORARY (2026-07-29): back on LemonSlice for demo reliability. The
 * self-hosted dock (FoxDailyCall on our A100) is intact and still runs
 * /fox-demo and /fox-meet — only this dock reverted. Vehicle context comes
 * back with it, since LemonSlice takes a --vehicle flag and Ditto does not.
 */
export default function FoxWidget() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Pre-warm the fox daemon on page load (free — no LemonSlice session yet),
  // so clicking the fox skips the Python boot entirely.
  useEffect(() => {
    fetch("/api/fox-room?warm=1").catch(() => {});
  }, []);

  // Any CTA on the site can open the dock by dispatching this event
  // (see AskFoxButton) — there's no separate full-page fox experience.
  useEffect(() => {
    const openDock = () => setOpen(true);
    window.addEventListener("carfox:open", openDock);
    return () => window.removeEventListener("carfox:open", openDock);
  }, []);

  // The passcode gate is pre-login — no fox until you're inside.
  // /fox-demo is the zero-bloat Ditto test bench — nothing else on the page.
  // /fox-meet IS a meeting bot's camera: every pixel it renders is streamed
  // into Google Meet, so a floating "Talk to the Fox" button on top of the
  // fox was being broadcast to everyone in the call.
  if (pathname === "/gate" || pathname === "/fox-demo" || pathname === "/fox-meet") return null;

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
