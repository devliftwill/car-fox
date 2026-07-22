"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import FoxLiveCall from "./FoxLiveCall";

/**
 * Site-wide Car Fox dock — the Gemini-powered fox on every page.
 *
 * Collapsed: a floating fox button in the lower-right.
 * Open: a compact live-call panel (FoxLiveCall autostarts — browser-direct
 * Gemini Live + the local SVG fox; no sidecar, no avatar vendor, nothing to
 * pre-warm). Page-aware: on /vehicles/[slug] the fox starts the call already
 * knowing that exact car (VIN, price, CARFAX history). Closing the panel
 * unmounts the call, which closes the Gemini session.
 */
export default function FoxWidget() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Any CTA on the site can open the dock by dispatching this event
  // (see AskFoxButton) — there's no separate full-page fox experience.
  useEffect(() => {
    const openDock = () => setOpen(true);
    window.addEventListener("carfox:open", openDock);
    return () => window.removeEventListener("carfox:open", openDock);
  }, []);

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
            <span className="flex items-center gap-1">
              <a
                href="/avatar"
                title="Make your own talking avatar from a photo"
                aria-label="Create a custom avatar from a photo"
                onClick={() => setOpen(false)}
                style={{ fontSize: 14, textDecoration: "none", padding: "2px 6px" }}
              >
                📷
              </a>
              <button onClick={() => setOpen(false)} aria-label="End call and close">
                ✕
              </button>
            </span>
          </div>
          <div className="fox-dock-body">
            <FoxLiveCall key={pathname} vehicleSlug={vehicleSlug} compact autoStart />
          </div>
        </div>
      )}
    </>
  );
}
