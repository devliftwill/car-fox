"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CARS, money } from "@/lib/cars";

/**
 * Faithful rebuild of Squarespace's homepage "angled-carousel":
 * - centered active card at scale 1
 * - neighbors at scale .88, tilted ±2°, offset ±~98% of card width
 * - outer cards at scale .78, ±3.6°, mostly offscreen
 * - steps card-by-card on a timer with an eased slide; pauses on hover
 * (Measured from squarespace.com: matrix(.879,-.031,.031,.879,-638,19) etc.)
 */
export default function AngledCarousel() {
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState(false);
  const n = CARS.length;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (hover) return;
    timer.current = setInterval(() => setActive((a) => (a + 1) % n), 3400);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [hover, n]);

  // relative offset in [-n/2, n/2]
  const rel = (i: number) => {
    let d = i - active;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    return d;
  };

  const styleFor = (d: number): React.CSSProperties => {
    const unit = "var(--acw)"; // card width (responsive, set in globals.css)
    const abs = Math.abs(d);
    const sign = d < 0 ? -1 : 1;
    if (abs > 2.5) return { opacity: 0, pointerEvents: "none", transform: "translateX(-50%) scale(.6)" };
    const scale = abs === 0 ? 1 : abs === 1 ? 0.879 : 0.78;
    const rot = abs === 0 ? 0 : sign * (abs === 1 ? 2 : 3.6);
    const y = abs === 0 ? 24 : abs === 1 ? 19 : 10;
    return {
      transform: `translateX(calc(-50% + ${d} * ${unit} * 0.985)) translateY(${y}px) rotate(${rot}deg) scale(${scale})`,
      zIndex: 10 - abs,
      opacity: 1,
    };
  };

  return (
    <section
      className="angled relative z-20 -mt-[21vh]"
      aria-label="Featured inventory"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="angled-stage">
        {CARS.map((c, i) => {
          const d = rel(i);
          const isActive = d === 0;
          return (
            <Link
              key={c.slug}
              href={`/vehicles/${c.slug}`}
              className={`angled-card ${isActive ? "is-active" : ""}`}
              style={styleFor(d)}
              onClick={(e) => {
                if (!isActive) {
                  e.preventDefault();
                  setActive(i);
                }
              }}
              tabIndex={isActive ? 0 : -1}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.image} alt={`${c.year} ${c.make} ${c.model}`} loading="lazy" />
              <div className="ac-cap">
                <span>
                  {c.year} {c.make} {c.model}
                </span>
                <span className="ac-price">{money(c.price)}</span>
              </div>
            </Link>
          );
        })}
      </div>
      {/* dots */}
      <div className="mt-7 flex justify-center gap-2.5">
        {CARS.map((c, i) => (
          <button
            key={c.slug}
            onClick={() => setActive(i)}
            aria-label={`Show ${c.year} ${c.make} ${c.model}`}
            className={`h-[6px] rounded-full transition-all duration-300 ${
              i === active ? "w-7 bg-neutral-900" : "w-[6px] bg-neutral-300 hover:bg-neutral-400"
            }`}
          />
        ))}
      </div>
    </section>
  );
}
