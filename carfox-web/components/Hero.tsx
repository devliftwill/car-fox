"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hero: full-bleed video (end-card-free loop), light centered headline,
 * and ONE call to action — a pulsing, centered "Watch the film" play button
 * that switches to the full spot with sound (Squarespace film pattern).
 */
export default function Hero() {
  const vidRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<"ambient" | "film">("ambient");
  const [ok, setOk] = useState(true);

  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const fail = () => setOk(false);
    v.addEventListener("error", fail);
    const t = setTimeout(() => {
      if (v.readyState < 2) setOk(false);
    }, 2500);
    return () => {
      clearTimeout(t);
      v.removeEventListener("error", fail);
    };
  }, []);

  const enterFilm = () => {
    const v = vidRef.current;
    if (!v) return;
    setMode("film");
    v.src = "/banner.mp4";
    v.muted = false;
    v.loop = false;
    v.currentTime = 0;
    v.play().catch(() => {});
  };

  const exitFilm = () => {
    const v = vidRef.current;
    if (!v) return;
    setMode("ambient");
    v.src = "/banner-loop.mp4";
    v.muted = true;
    v.loop = true;
    v.currentTime = 0;
    v.play().catch(() => {});
  };

  return (
    <header className="relative flex h-[100svh] min-h-[640px] items-center justify-center overflow-hidden bg-black text-white">
      <div className="hero-media absolute inset-0">
        {ok ? (
          <video
            ref={vidRef}
            autoPlay
            muted
            loop
            playsInline
            poster="/banner-poster.jpg"
            src="/banner-loop.mp4"
            onEnded={() => mode === "film" && exitFilm()}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/banner-poster.jpg" alt="" className="hero-poster" />
        )}
      </div>
      <div
        className={`absolute inset-0 transition-opacity duration-700 ${
          mode === "film" ? "opacity-0" : "opacity-100"
        } bg-[linear-gradient(180deg,rgba(0,0,0,.42),rgba(0,0,0,.18)_45%,rgba(0,0,0,.55))]`}
      />

      {/* Ambient content */}
      <div
        className={`relative z-10 -mt-[10vh] px-6 text-center transition-all duration-700 ${
          mode === "film" ? "pointer-events-none -translate-y-4 opacity-0" : "opacity-100"
        }`}
      >
        <h1 className="sq-h1">
          Every car
          <br />
          has a story
        </h1>

        {/* THE call to action */}
        <button onClick={enterFilm} className="play-cta group mt-12" aria-label="Watch the film">
          <span className="play-rings" aria-hidden>
            <span />
            <span />
          </span>
          <span className="play-disc">
            <svg width="20" height="24" viewBox="0 0 18 20" fill="currentColor" aria-hidden>
              <path d="M0 0 L18 10 L0 20 Z" />
            </svg>
          </span>
        </button>
        <div className="mt-6 text-[13px] font-medium uppercase tracking-[0.24em] opacity-90">
          Watch the film
        </div>
        <p className="mt-3 text-[14px] opacity-75">
          Then ask the Fox about any car on the lot — he&apos;s in the corner.
        </p>
      </div>

      {/* Film mode exit */}
      {mode === "film" && (
        <button
          onClick={exitFilm}
          className="absolute right-[4vw] top-24 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/60 bg-black/40 text-white backdrop-blur-sm transition hover:border-white"
          aria-label="Back to ambient loop"
        >
          ✕
        </button>
      )}
    </header>
  );
}
