import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Logo from "@/components/Logo";
import { CARS, getCar, money, km } from "@/lib/cars";

export function generateStaticParams() {
  return CARS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const car = getCar(slug);
  if (!car) return { title: "Vehicle — Car Fox" };
  return { title: `${car.year} ${car.make} ${car.model} — Car Fox` };
}

type HistoryIcon = "check" | "alert" | "owner" | "car" | "service";

function HistoryGlyph({ icon }: { icon: HistoryIcon }) {
  const paths: Record<HistoryIcon, React.ReactNode> = {
    check: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 4.5-5" />
      </>
    ),
    alert: (
      <>
        <path d="M12 3.5 21 19H3z" />
        <path d="M12 10v4" />
        <path d="M12 17h.01" />
      </>
    ),
    owner: (
      <>
        <rect x="6" y="4" width="12" height="17" rx="1.5" />
        <path d="M9 4.5V4a3 3 0 0 1 6 0v.5" />
        <path d="M9 11h6M9 15h4" />
      </>
    ),
    car: (
      <>
        <path d="M4 16v-3l2-5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 8l2 5v3" />
        <path d="M3 16h18v2a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
        <path d="M6 12h12" />
      </>
    ),
    service: (
      <>
        <path d="M14.5 5.5a3.8 3.8 0 0 0-5 5L4 16v3.5h3.5L13 14a3.8 3.8 0 0 0 5-5l-2.2 2.2-2-2z" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`mt-0.5 h-5 w-5 shrink-0 ${icon === "alert" ? "text-amber-500" : "text-neutral-900"}`}
    >
      {paths[icon]}
    </svg>
  );
}

export default async function VehiclePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const car = getCar(slug);
  if (!car) notFound();

  const name = `${car.year} ${car.make} ${car.model}${car.trim ? " " + car.trim : ""}`;
  const clean = car.history.accidents === "none";

  const specs: [string, string][] = [
    ["Price", money(car.price)],
    ["Mileage", km(car.miles)],
    ["Engine", car.engine],
    ["Transmission", car.trans],
    ["Drivetrain", car.drive],
    ["MPG City/Hwy", car.mpg],
    ["Exterior", car.exterior],
    ["Interior", car.interior],
    ["Body", car.body],
    ["Location", car.dealerCity],
    ["Status", car.certified ? "Certified Pre-Owned" : "Used"],
    ["VIN", car.vin],
  ];

  const history: { icon: HistoryIcon; text: string }[] = [
    clean
      ? { icon: "check", text: "No accident or damage reported to CARFAX." }
      : {
          icon: "alert",
          text: "Minor damage reported. Nothing structural on record — but this is exactly the kind of thing to ask the Fox about before you buy.",
        },
    {
      icon: "owner",
      text: `${car.history.owners} previous owner${car.history.owners === "1" ? "" : "s"} on record.`,
    },
    {
      icon: "car",
      text: car.history.personalUse
        ? "Personal-use vehicle — not a rental or fleet car."
        : "Commercial-use history reported.",
    },
    {
      icon: "service",
      text: car.history.serviceHistory
        ? `Service history on file${
            car.history.serviceRecords ? ` — ${car.history.serviceRecords} service records reported` : ""
          }.`
        : "No service records reported.",
    },
  ];

  return (
    <main>
      <Nav solid />

      {/* Full-bleed image lead */}
      <header className="relative mt-[68px] h-[62vh] min-h-[420px] overflow-hidden bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={car.image} alt={name} className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_45%,rgba(0,0,0,.62))]" />
        <div className="absolute inset-x-0 bottom-0 px-[4vw] pb-12 text-white">
          <div className="sq-kicker opacity-80">
            {car.year} · {car.body} · VIN {car.vin}
          </div>
          <h1 className="sq-h2 mt-2">{name}</h1>
        </div>
        <div className="absolute right-3 top-3 max-w-[70vw] rounded-sm bg-black/55 px-2.5 py-1 text-[9px] uppercase tracking-[0.12em] text-white/80 sm:px-3 sm:py-1.5 sm:text-[11px] sm:tracking-[0.14em]">
          Representative photo — see CARFAX listing for actual vehicle
        </div>
      </header>

      {/* Price bar */}
      <section className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-[4vw] py-8">
          <div>
            <div className="flex items-baseline gap-4">
              <span className="text-[30px] font-semibold tracking-tight">{money(car.price)}</span>
              {car.belowValue && (
                <span className="text-[14px] font-semibold text-green-700">
                  {money(car.belowValue)} below CARFAX Value
                </span>
              )}
            </div>
            <div className="mt-1 text-[14px] text-neutral-500">
              {km(car.miles)} · {car.engine} · {car.trans} · {car.drive} · {car.dealerCity}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <a className="sq-btn sq-btn--black" href={car.carfaxUrl} target="_blank" rel="noopener">
              View free CARFAX report
            </a>
            <span className="sq-btn cursor-default select-none border border-neutral-900 text-neutral-900">
              Book test drive
            </span>
          </div>
        </div>
      </section>

      {/* Ask-the-fox strip */}
      <section className="bg-[#fdf2ea] px-[4vw] py-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <p className="text-[15px] leading-relaxed">
            🦊 <b style={{ color: "var(--fox)" }}>Ask the Car Fox about this car.</b> He starts the
            call already knowing this {car.model} — VIN, price, history, everything on this page.
          </p>
          <Link
            href={`/live?vehicle=${car.slug}`}
            className="sq-btn sq-btn--black whitespace-nowrap !py-3.5 !px-6"
          >
            Talk to the Fox about this car
          </Link>
        </div>
      </section>

      {/* Specs */}
      <section className="mx-auto max-w-7xl px-[4vw] py-20">
        <h2 className="sq-h2 mb-12">Specifications</h2>
        <div className="spec-grid">
          {specs.map(([k, v]) => (
            <div key={k} className="spec-cell">
              <div className="sq-kicker text-neutral-500">{k}</div>
              <div className="mt-2 text-[17px] font-medium tracking-tight break-all">{v}</div>
            </div>
          ))}
        </div>
      </section>

      {/* History */}
      <section className="mx-auto max-w-7xl px-[4vw] pb-24">
        <h2 className="sq-h2 mb-4">CARFAX history highlights</h2>
        <p className="mb-10 text-[14px] text-neutral-500">
          From the live CARFAX listing for VIN {car.vin}.{" "}
          <a className="underline" href={car.carfaxUrl} target="_blank" rel="noopener">
            Full report here
          </a>
          .
        </p>
        <div>
          {history.map((h) => (
            <div
              key={h.text}
              className="flex items-start gap-4 border-b border-neutral-200 py-6 text-[15.5px] leading-relaxed"
            >
              <HistoryGlyph icon={h.icon} />
              <span>{h.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#0e0e0e] px-[4vw] py-28 text-center text-white">
        <h2 className="sq-h2">Still deciding?</h2>
        <p className="mt-5 text-[16px] text-neutral-400">
          The Fox knows this car&apos;s whole story. Ask him anything — he&apos;s in the corner.
        </p>
        <Link href="/#inventory" className="sq-btn sq-btn--white mt-10 inline-block">
          Back to the lot
        </Link>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-4 px-[4vw] py-12 text-[13px] text-neutral-500">
        <Logo height={18} />
        <span>Real VINs via CARFAX listings · Photos representative · Live avatar by LemonSlice</span>
      </footer>
    </main>
  );
}
