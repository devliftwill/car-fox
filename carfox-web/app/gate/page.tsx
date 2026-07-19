"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

function GateForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/";

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        // Full navigation so the middleware re-runs with the new cookie.
        window.location.assign(from.startsWith("/") ? from : "/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "That code isn't right.");
      setCode("");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        background: "#0e0e0e",
        color: "#fff",
        padding: "24px",
      }}
    >
      <div style={{ width: "min(92vw, 380px)", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/carfox-avatar.png"
          alt=""
          width={72}
          height={72}
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            objectFit: "cover",
            margin: "0 auto 26px",
            border: "2px solid rgba(255,255,255,.14)",
          }}
        />

        <div className="sq-kicker" style={{ color: "var(--fox)" }}>
          Private preview
        </div>
        <h1
          className="sq-h2"
          style={{ fontSize: "clamp(30px, 6vw, 44px)", marginTop: 14 }}
        >
          Car&nbsp;Fox
        </h1>
        <p
          style={{
            marginTop: 14,
            fontSize: 15,
            lineHeight: 1.5,
            color: "rgba(255,255,255,.55)",
          }}
        >
          This site isn&apos;t public yet. Enter your access code to take a look.
        </p>

        <form onSubmit={submit} style={{ marginTop: 32 }}>
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
            style={{
              width: "100%",
              padding: "16px 18px",
              fontSize: 16,
              letterSpacing: "0.06em",
              textAlign: "center",
              color: "#fff",
              background: "rgba(255,255,255,.05)",
              border: `1px solid ${error ? "var(--fox)" : "rgba(255,255,255,.18)"}`,
              borderRadius: 0,
              outline: "none",
              transition: "border-color .18s, background .18s",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,.55)";
              e.currentTarget.style.background = "rgba(255,255,255,.08)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = error
                ? "var(--fox)"
                : "rgba(255,255,255,.18)";
              e.currentTarget.style.background = "rgba(255,255,255,.05)";
            }}
          />

          <div
            style={{
              minHeight: 20,
              marginTop: 10,
              fontSize: 13,
              color: "var(--fox)",
              opacity: error ? 1 : 0,
              transition: "opacity .18s",
            }}
            role="alert"
          >
            {error || " "}
          </div>

          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="sq-btn sq-btn--white"
            style={{
              width: "100%",
              marginTop: 6,
              opacity: busy || !code.trim() ? 0.55 : 1,
              cursor: busy || !code.trim() ? "default" : "pointer",
            }}
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function GatePage() {
  return (
    <Suspense fallback={null}>
      <GateForm />
    </Suspense>
  );
}
