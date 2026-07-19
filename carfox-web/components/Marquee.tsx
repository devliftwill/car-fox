"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { CARS, money } from "@/lib/cars";

/**
 * Squarespace-style template carousel:
 * - continuous glide via rAF (not CSS keyframes)
 * - scroll velocity feeds the marquee speed, then decays back to cruise
 * - seamless wrap at half-width (content duplicated once)
 * - staggered vertical offsets + hover pause/zoom
 */
export default function Marquee() {
  const trackRef = useRef<HTMLDivElement>(null);
  const state = useRef({ x: 0, boost: 0, lastY: 0, half: 0, hover: false, raf: 0 });

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const s = state.current;
    s.lastY = window.scrollY;

    const measure = () => { s.half = track.scrollWidth / 2; };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);

    const onScroll = () => {
      const dy = window.scrollY - s.lastY;
      s.lastY = window.scrollY;
      s.boost += dy * 0.1;                        // whisper of scroll energy
      s.boost = Math.max(-30, Math.min(30, s.boost));
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onEnter = () => (s.hover = true);
    const onLeave = () => (s.hover = false);
    track.addEventListener("mouseenter", onEnter);
    track.addEventListener("mouseleave", onLeave);

    let last = performance.now();
    const CRUISE = 42; // px/s
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const cruise = s.hover ? 6 : CRUISE;
      s.x -= (cruise + s.boost) * dt;
      s.boost *= Math.pow(0.001, dt);            // exponential decay toward cruise
      if (s.half > 0) {
        if (s.x <= -s.half) s.x += s.half;
        if (s.x > 0) s.x -= s.half;
      }
      track.style.transform = `translate3d(${s.x}px,0,0)`;
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      track.removeEventListener("mouseenter", onEnter);
      track.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  const cars = [...CARS, ...CARS];

  return (
    <section className="marquee relative z-20 -mt-[19vh]" aria-label="Featured inventory">
      <div ref={trackRef} className="marquee-track" style={{ animation: "none" }}>
        {cars.map((c, i) => (
          <Link
            key={c.slug + i}
            href={`/vehicles/${c.slug}`}
            className="marquee-card"
            tabIndex={i >= CARS.length ? -1 : 0}
            aria-hidden={i >= CARS.length}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.image} alt={`${c.year} ${c.make} ${c.model}`} loading="lazy" />
            <div className="mc-cap">
              <span className="text-[17px] font-medium tracking-tight">
                {c.year} {c.make} {c.model}
              </span>
              <span className="text-[15px] opacity-85">{money(c.price)}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
