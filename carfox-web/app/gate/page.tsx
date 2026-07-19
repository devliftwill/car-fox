"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Passcode gate — the first thing an invited guest sees. Quiet ink-dark
 * backdrop with a faint fox-orange glow, light type, one centered action.
 * Everything else on the site is behind this page.
 */
function GateForm() {
  const params = useSearchParams();
  const from = params.get("from") || "/";

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        // Full navigation so the proxy re-runs with the new cookie.
        window.location.assign(from.startsWith("/") ? from : "/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "That code isn't right.");
      setShake(true);
      setCode("");
    } catch {
      setError("Something went wrong. Try again.");
      setShake(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-[#0e0e0e] text-white">
      {/* Faint fox-orange glow behind the content — keeps the ink from going flat */}
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_62%_46%_at_50%_36%,rgba(212,100,42,.12),transparent_72%)]"
        aria-hidden
      />

      <div className="relative z-10 w-[min(92vw,400px)] px-2 py-16 text-center">
        <div className="fox-boot-avatar mx-auto !h-[76px] !w-[76px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/carfox-avatar.png" alt="" />
          <span />
          <span />
        </div>

        <div className="sq-kicker mt-8" style={{ color: "var(--fox)" }}>
          Private preview
        </div>
        <h1 className="sq-h2 mt-3" style={{ fontSize: "clamp(38px, 7vw, 56px)" }}>
          Car&nbsp;Fox
        </h1>
        <p className="mx-auto mt-4 max-w-[30ch] text-[15px] leading-relaxed text-white/60">
          We&apos;re not open to the public yet. Enter your access code to step
          onto the lot.
        </p>

        <form onSubmit={submit} className="mt-9">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Access code"
            aria-invalid={!!error}
            className={`gate-input ${error ? "is-error" : ""} ${shake ? "do-shake" : ""}`}
            onAnimationEnd={() => setShake(false)}
          />

          <div
            className="mt-2.5 min-h-5 text-[13px] transition-opacity duration-200"
            style={{ color: "var(--fox)", opacity: error ? 1 : 0 }}
            role="alert"
          >
            {error || " "}
          </div>

          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="sq-btn sq-btn--white mt-1.5 w-full disabled:cursor-default disabled:opacity-55"
          >
            {busy ? "Checking…" : "Enter the lot"}
          </button>
        </form>

        <p className="mt-9 text-[12px] tracking-wide text-white/40">
          Access is by invitation only.
        </p>
      </div>
    </main>
  );
}

export default function GatePage() {
  return (
    <Suspense fallback={<main className="min-h-[100svh] bg-black" />}>
      <GateForm />
    </Suspense>
  );
}
