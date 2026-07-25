"use client";

/**
 * /fox-demo — the live Car Fox, nothing else on the page.
 *
 *   /fox-demo              -> LemonSlice avatar (production, known-good)
 *   /fox-demo?engine=self  -> our self-hosted Ditto avatar on the A100
 *
 * Same bare page either way, so the two engines can be compared directly
 * with no library UI, no corner dock, nothing to muddy the judgement.
 */
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import FoxRoomCall from "@/components/FoxRoomCall";
import FoxDailyCall from "@/components/FoxDailyCall";

function Demo() {
  const selfHosted = useSearchParams().get("engine") === "self";
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 p-6">
      <p className="mb-6 text-[13px] uppercase tracking-[0.2em] text-neutral-500">
        {selfHosted ? "Car Fox — self-hosted (Ditto × Gemini)" : "Car Fox — live"}
      </p>
      <div className="w-full max-w-[440px]">
        {selfHosted ? <FoxDailyCall avatarId="fox_ditto" /> : <FoxRoomCall autoStart />}
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
