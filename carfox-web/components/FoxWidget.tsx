"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import FoxDailyCall from "./FoxDailyCall";

/**
 * Site-wide Car Fox dock — the Gemini-powered fox on every page.
 *
 * Collapsed: a floating fox button in the lower-right.
 * Open: our SELF-HOSTED fox (Ditto on the A100 via Daily), not LemonSlice.
 *
 * Two things the LemonSlice dock gave us for free and this does not:
 *   - the GPU box sleeps, so a cold open needs a wake (~2 min). We poll for
 *     it and show progress rather than failing at a dead endpoint.
 *   - vehicle context. FoxDailyCall has no --vehicle equivalent yet, so on
 *     /vehicles/[slug] the fox does NOT know which car you are looking at.
 *
 * Deliberately NOT pre-warmed on page load: waking costs $3.67/hr, and every
 * visitor to any page would have kept a GPU alive. The wake starts when
 * somebody actually opens the dock.
 */
export default function FoxWidget() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [waking, setWaking] = useState(0);
  const pathname = usePathname();

  // Wake the studio only once the dock is actually opened. The box sleeps to
  // keep cost down, so a cold open takes ~2 minutes; poll until the bot
  // answers and count the seconds so the wait is visible rather than silent.
  useEffect(() => {
    if (!open || ready) return;
    let stop = false;
    const t0 = Date.now();
    const tick = setInterval(() => setWaking(Math.round((Date.now() - t0) / 1000)), 1000);
    (async () => {
      for (let i = 0; i < 80 && !stop; i++) {
        try {
          const r = await fetch("/api/neural/wake?for=pipecat");
          const j = await r.json().catch(() => ({}));
          // The route reports {status:"ready"} — not {ready:true}. Getting
          // this wrong makes the dock spin for the full timeout.
          if (j?.status === "ready") {
            setReady(true);
            break;
          }
        } catch {
          /* studio still starting */
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => {
      stop = true;
      clearInterval(tick);
    };
  }, [open, ready]);

  // Any CTA on the site can open the dock by dispatching this event
  // (see AskFoxButton) — there's no separate full-page fox experience.
  useEffect(() => {
    const openDock = () => setOpen(true);
    window.addEventListener("carfox:open", openDock);
    return () => window.removeEventListener("carfox:open", openDock);
  }, []);

  // The passcode gate is pre-login — no fox until you're inside.
  // /fox-demo is the zero-bloat Ditto test bench — nothing else on the page.
  if (pathname === "/gate" || pathname === "/fox-demo") return null;

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
            {ready ? (
              <FoxDailyCall key={pathname} avatarId="fox_ditto" />
            ) : (
              <div style={{ padding: "1.25rem", textAlign: "center", fontSize: 13, lineHeight: 1.6 }}>
                Waking the fox studio… {waking}s
                <div style={{ opacity: 0.6, marginTop: 6 }}>
                  The GPU sleeps between calls to keep costs down. First call
                  takes about two minutes; after that it is instant.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
