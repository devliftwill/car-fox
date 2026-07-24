"use client";

/**
 * /fox-demo — zero-bloat test bench for the Ditto fox over Daily.
 *
 * ONE thing on the page: the call. No corner dock, no avatar library,
 * no recorder, no thumbnails — so what you see is the engine + transport
 * and nothing else.
 */
import { useEffect, useState } from "react";
import FoxDailyCall from "@/components/FoxDailyCall";

export default function FoxDemo() {
  const [studio, setStudio] = useState<"waking" | "ready" | "error">("waking");

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = async () => {
      const j = await fetch("/api/neural/wake").then((r) => r.json()).catch(() => null);
      if (!alive) return;
      if (j?.status === "ready") {
        setStudio("ready");
        return;
      }
      if (!j || j.status === "error" || ++tries > 40) {
        setStudio("error");
        return;
      }
      setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 p-6">
      <p className="mb-6 text-[13px] uppercase tracking-[0.2em] text-neutral-500">
        Fox demo — Ditto × Gemini × Daily
      </p>
      {studio === "ready" ? (
        <FoxDailyCall avatarId="fox_ditto" />
      ) : (
        <p className="text-[14px] text-neutral-400">
          {studio === "waking" ? "Waking the studio…" : "Studio unreachable — try again in a minute."}
        </p>
      )}
    </main>
  );
}
