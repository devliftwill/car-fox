"use client";

import { useEffect, useState } from "react";
import FoxDailyCall from "@/components/FoxDailyCall";

/**
 * The surface a meeting bot streams as its camera.
 *
 * Recall.ai renders this URL and pipes its audio+video into the meeting, so it
 * has to work with NOBODY to click anything:
 *   - the site passcode is bypassed for this path only, on a separate secret
 *     (?k=), handled in proxy.ts — the bot's browser has no session cookie
 *   - the studio is woken automatically, because the GPU sleeps between calls
 *   - the call starts itself once the studio answers
 *
 * Full-bleed and chrome-free: every pixel here becomes the bot's video feed,
 * so there is no room for headers, buttons or padding.
 */
export default function FoxMeetPage() {
  const [ready, setReady] = useState(false);
  const [waking, setWaking] = useState(0);

  useEffect(() => {
    let stop = false;
    const t0 = Date.now();
    const tick = setInterval(() => setWaking(Math.round((Date.now() - t0) / 1000)), 1000);
    (async () => {
      for (let i = 0; i < 100 && !stop; i++) {
        try {
          const r = await fetch("/api/neural/wake?for=pipecat");
          const j = await r.json().catch(() => ({}));
          if (j?.status === "ready") {
            setReady(true);
            break;
          }
        } catch {
          /* studio still booting */
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => {
      stop = true;
      clearInterval(tick);
    };
  }, []);

  // Hold the studio awake for as long as this page is rendering.
  //
  // The GPU box powers itself off when it looks idle, and its idle check knows
  // nothing about meeting bots — so it shut the box down MID-MEETING, which is
  // what produced a black frame with "waking up" underneath it. The demo page
  // has always pinged this; the bot surface did not.
  //
  // Deliberately NOT gated on `ready`: the wake itself takes ~2 minutes, and
  // the box has to survive that window too. Recall keeps this page rendering
  // for the whole call, so the lock lasts exactly as long as the bot is in the
  // meeting and expires once it leaves — the cost saving is preserved.
  useEffect(() => {
    const ping = () =>
      void fetch("/api/neural/pipecat?path=keepalive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {});
    ping();
    const id = setInterval(ping, 45000);
    return () => clearInterval(id);
  }, []);

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "#0b0b0c",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      {ready ? (
        // autoStart: no human will ever press a button inside a bot's browser
        <FoxDailyCall avatarId="fox_ditto" autoStart />
      ) : (
        <div className="fox-live-frame" style={{ width: "min(88vmin, 720px)", aspectRatio: "1 / 1" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/carfox-avatar.png"
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.5 }}
          />
          <div className="fox-live-wake">
            <span className="fox-live-pulse" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="fox-live-status">Waking the fox · {waking}s</span>
          </div>
        </div>
      )}
    </main>
  );
}
