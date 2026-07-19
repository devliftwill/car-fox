"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "./Logo";

export default function Nav({ solid = false }: { solid?: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (solid) return;
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [solid]);

  const isSolid = solid || scrolled;

  return (
    <nav
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-between px-[4vw] py-5 transition-colors duration-300 ${
        isSolid ? "nav-solid" : "nav-clear"
      }`}
    >
      <Link href="/" aria-label="CARFAX Canada — home">
        <Logo height={22} />
      </Link>
      <div className="flex items-center gap-8 text-[13px] font-medium tracking-[0.14em] uppercase">
        <Link href="/#inventory" className="hidden sm:inline opacity-90 hover:opacity-100">
          Inventory
        </Link>
        <Link href="/#fox" className="hidden sm:inline opacity-90 hover:opacity-100">
          The Fox
        </Link>
        <Link
          href="/#inventory"
          className={`sq-btn !px-6 !py-3 !text-[12.5px] ${isSolid ? "sq-btn--black" : "sq-btn--white"}`}
        >
          Browse the lot
        </Link>
      </div>
    </nav>
  );
}
