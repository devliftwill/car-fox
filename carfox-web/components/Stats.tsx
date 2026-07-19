"use client";

import { useEffect, useRef, useState } from "react";

type Stat = { value: number; prefix?: string; suffix: string; label: string; decimals?: number };

const STATS: Stat[] = [
  { value: 6, suffix: "", label: "Real vehicles, real VINs" },
  { value: 5, suffix: "", label: "Clean CARFAX histories" },
  { value: 1, suffix: "", label: "Disclosed incident — ask the Fox" },
  { value: 30573, prefix: "$", suffix: "", label: "Below CARFAX value, combined" },
];

function Counter({ stat, run }: { stat: Stat; run: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    const t0 = performance.now();
    const dur = 1400;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(stat.value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, stat.value]);

  const shown = stat.decimals ? n.toFixed(stat.decimals) : Math.round(n).toLocaleString("en-US");
  return (
    <span>
      {stat.prefix}
      {shown}
      {stat.suffix}
    </span>
  );
}

export default function Stats() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setOn(true),
      { threshold: 0.35 }
    );
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  return (
    <section ref={ref} className="bg-[#0e0e0e] text-white px-[4vw] pt-40 pb-28">
      <p
        className={`fade-up ${on ? "on" : ""} text-center text-[15px] text-neutral-400 mb-20`}
      >
        Join drivers who ask before they buy.
      </p>
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-14 md:grid-cols-4">
        {STATS.map((s, i) => (
          <div
            key={s.label}
            className={`fade-up ${on ? "on" : ""} text-center`}
            style={{ transitionDelay: `${i * 150}ms` }}
          >
            <div className="text-5xl md:text-6xl font-light tracking-tight">
              <Counter stat={s} run={on} />
            </div>
            <div className="mt-4 text-[13px] uppercase tracking-[0.18em] text-neutral-400">
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
