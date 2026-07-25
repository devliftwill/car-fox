"use client";

/**
 * /fox-demo — the live Car Fox, nothing else on the page.
 *
 *   /fox-demo              -> LemonSlice avatar (production, known-good)
 *   /fox-demo?engine=self  -> our self-hosted Ditto avatar on the A100
 *
 * Same bare page either way, so the two engines can be compared directly.
 *
 * The self-hosted GPU box stops itself when idle (that is the whole cost
 * argument), so a cold visit has to WAKE it — ~90s for the VM plus model
 * load. This page does that wake and reports progress; rendering the call
 * before the bot answers is what produced "Couldn't reach the fox".
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import FoxRoomCall from "@/components/FoxRoomCall";
import FoxDailyCall from "@/components/FoxDailyCall";

function SelfHosted() {
  const [studio, setStudio] = useState<"waking" | "ready" | "error">("waking");
  const [secs, setSecs] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    const clock = setInterval(() => {
      if (alive) setSecs(Math.round((Date.now() - startedAt.current) / 1000));
    }, 1000);
    const tick = async () => {
      const j = await fetch("/api/neural/wake?for=pipecat")
        .then((r) => r.json())
        .catch(() => null);
      if (!alive) return;
      if (j?.status === "ready") return setStudio("ready");
      // the studio needs ~90s from cold; keep polling well past that
      if (Date.now() - startedAt.current > 240000) return setStudio("error");
      setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
      clearInterval(clock);
    };
  }, []);

  if (studio === "ready") return <FoxDailyCall avatarId="fox_ditto" />;

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-neutral-900 p-6 text-center"
      style={{ aspectRatio: "1 / 1" }}
    >
      {studio === "waking" ? (
        <>
          <p className="text-[14px] text-neutral-300">Waking the GPU studio… 🦊</p>
          <p className="text-[12px] text-neutral-500">
            It powers down when idle to keep costs near zero. First visit takes
            about 90 seconds. ({secs}s)
          </p>
        </>
      ) : (
        <>
          <p className="text-[13px] text-red-400">The studio didn&apos;t come up.</p>
          <button onClick={() => location.reload()} className="sq-btn sq-btn--white">
            Try again
          </button>
        </>
      )}
    </div>
  );
}

function Demo() {
  const selfHosted = useSearchParams().get("engine") === "self";
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 p-6">
      <p className="mb-6 text-[13px] uppercase tracking-[0.2em] text-neutral-500">
        {selfHosted ? "Car Fox — self-hosted (Ditto × Gemini)" : "Car Fox — live"}
      </p>
      <div className="w-full max-w-[440px]">
        {selfHosted ? <SelfHosted /> : <FoxRoomCall autoStart />}
      </div>
      <p className="mt-6 text-[12px] text-neutral-600">
        {selfHosted ? (
          <a className="underline" href="/fox-demo">compare with LemonSlice →</a>
        ) : (
          <a className="underline" href="/fox-demo?engine=self">compare with self-hosted →</a>
        )}
      </p>
    </main>
  );
}

export default function FoxDemo() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-neutral-950" />}>
      <Demo />
    </Suspense>
  );
}
