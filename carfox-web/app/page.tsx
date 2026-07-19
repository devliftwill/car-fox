import Link from "next/link";
import Nav from "@/components/Nav";
import Stats from "@/components/Stats";
import Hero from "@/components/Hero";
import AngledCarousel from "@/components/AngledCarousel";
import Logo from "@/components/Logo";
import { CARS, money, km } from "@/lib/cars";

export default function Home() {
  return (
    <main>
      <Nav />

      {/* HERO — full-bleed film, centered play CTA */}
      <Hero />

      {/* ANGLED CAROUSEL — Squarespace homepage pattern */}
      <AngledCarousel />

      {/* STATS — black band, fade-in counters (Squarespace stats pattern) */}
      <Stats />

      {/* INVENTORY */}
      <section id="inventory" className="mx-auto max-w-7xl px-[4vw] py-28">
        <div className="mb-14 flex flex-wrap items-end justify-between gap-6">
          <h2 className="sq-h2">On the lot now</h2>
          <p className="text-[15px] text-neutral-500">
            {CARS.length} cars · every one vetted by the Fox
          </p>
        </div>
        <div className="grid grid-cols-1 gap-7 sm:grid-cols-2 lg:grid-cols-3">
          {CARS.map((c) => (
            <Link key={c.slug} href={`/vehicles/${c.slug}`} className="inv-card">
              <div className="overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.image} alt={`${c.year} ${c.make} ${c.model}`} loading="lazy" />
              </div>
              <div className="p-6">
                <div className="sq-kicker text-neutral-500">
                  {c.year} · {c.body} · {c.drive}
                  {c.history.accidents === "none" ? " · Clean history" : " · Ask the Fox"}
                </div>
                <h3 className="mt-2 text-[21px] font-medium tracking-tight">
                  {c.make} {c.model} {c.trim ?? ""}
                </h3>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-[18px] font-semibold">{money(c.price)}</span>
                  <span className="text-[14px] text-neutral-500">{km(c.miles)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* FOX BAND */}
      <section id="fox" className="bg-[#0e0e0e] px-[4vw] py-32 text-center text-white">
        <h2 className="sq-h2 mx-auto max-w-3xl">
          The mascot in the corner? <span style={{ color: "var(--fox)" }}>He&apos;s real.</span>
        </h2>
        <p className="mx-auto mt-7 max-w-xl text-[16px] leading-relaxed text-neutral-400">
          Hit the video-chat bubble, allow your mic, and ask the Car Fox about any car on this
          lot — accidents, owners, what to check on a test drive. He answers out loud, face to
          face, in real time.
        </p>
        <p className="mt-10 text-[13px] uppercase tracking-[0.2em] text-neutral-500">
          Live now · bottom right corner
        </p>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-neutral-200 px-[4vw] py-12 text-[13px] text-neutral-500">
        <Logo height={18} />
        <span>Demo inventory · Live avatar by LemonSlice · Photography via Unsplash</span>
      </footer>
    </main>
  );
}
