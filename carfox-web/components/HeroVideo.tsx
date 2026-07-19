"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hero media, Squarespace-style:
 * - Ambient: /banner-loop.mp4 (muted, end-card trimmed) loops behind the headline.
 * - Play button → "film mode": full /banner.mp4 with sound from the top,
 *   returns to the ambient loop when it ends (or on ✕).
 */
export default function HeroVideo() {
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
    <>
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

      {/* Film controls */}
      {ok && mode === "ambient" && (
        <button
          onClick={enterFilm}
          className="group absolute left-[4vw] bottom-[24vh] z-30 flex items-center gap-3 text-white"
          aria-label="Watch the film with sound"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/70 bg-black/25 backdrop-blur-sm transition group-hover:scale-105 group-hover:border-white">
            <svg width="18" height="20" viewBox="0 0 18 20" fill="currentColor" aria-hidden>
              <path d="M0 0 L18 10 L0 20 Z" />
            </svg>
          </span>
          <span className="text-[13px] font-medium uppercase tracking-[0.18em] opacity-90">
            Watch the film
          </span>
        </button>
      )}
      {ok && mode === "film" && (
        <button
          onClick={exitFilm}
          className="absolute right-[4vw] top-24 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/60 bg-black/40 text-white backdrop-blur-sm transition hover:border-white"
          aria-label="Back to ambient loop"
        >
          ✕
        </button>
      )}
    </>
  );
}
