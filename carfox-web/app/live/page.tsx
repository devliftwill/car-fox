import type { Metadata } from "next";
import Nav from "@/components/Nav";
import FoxRoomCall from "@/components/FoxRoomCall";
import { getCar } from "@/lib/cars";

export const metadata: Metadata = {
  title: "Live with the Car Fox — Gemini edition",
};

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ vehicle?: string }>;
}) {
  const { vehicle } = await searchParams;
  const car = vehicle ? getCar(vehicle) : undefined;

  return (
    <main className="min-h-screen bg-white">
      <Nav solid />
      <section className="px-[4vw] pb-24 pt-40 text-center">
        <div className="sq-kicker text-neutral-500">Gemini 3.1 Flash Live · Direct</div>
        <h1 className="sq-h2 mt-3">
          {car ? `Ask the Fox about the ${car.year} ${car.make} ${car.model}` : "Talk to the Gemini Fox"}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-500">
          {car
            ? `He knows this ${car.model}'s whole story — VIN ${car.vin}, history, price, all of it. Allow your microphone and just ask.`
            : "Same fox face, new brain: Gemini's native voice drives the lips in real time. Allow your microphone and just talk — interruptions welcome."}
        </p>
      </section>
      <section className="pb-32">
        <FoxRoomCall vehicleSlug={car?.slug} />
      </section>
    </main>
  );
}
