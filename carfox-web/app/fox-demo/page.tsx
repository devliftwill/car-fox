"use client";

/**
 * /fox-demo — the live Car Fox, working.
 *
 * This uses the production LemonSlice avatar path (FoxRoomCall): visitor mic
 * -> LemonSlice-hosted Daily room -> fox-agent (Gemini 3.1 Flash Live, Puck
 * voice) -> LemonSlice avatar, A/V synced by LemonSlice. It is the same
 * engine as the corner dock, shown full-size with nothing else on the page.
 *
 * (The self-hosted Ditto engine remains an experiment on /avatar; it is not
 * yet at parity on latency, so the demo runs the proven path.)
 */
import FoxRoomCall from "@/components/FoxRoomCall";

export default function FoxDemo() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 p-6">
      <p className="mb-6 text-[13px] uppercase tracking-[0.2em] text-neutral-500">
        Car Fox — live
      </p>
      <div className="w-full max-w-[440px]">
        <FoxRoomCall autoStart />
      </div>
    </main>
  );
}
