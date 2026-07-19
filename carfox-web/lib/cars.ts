/**
 * REAL inventory — sourced from live CARFAX listings (pulled 2026-07-18, ZIP 90210 area).
 * Every VIN is a real vehicle; history flags come from the CARFAX listing badges.
 * carfaxUrl links to the listing page, which includes the free full CARFAX report.
 * Photos are representative stock photography, NOT the actual listed vehicle.
 */
export type Car = {
  slug: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  price: number;
  miles: number;
  body: string;
  mpg: string;
  drive: string;
  trans: string;
  engine: string;
  exterior: string;
  interior: string;
  vin: string;
  carfaxUrl: string;
  dealerCity: string;
  belowValue?: number;
  certified?: boolean;
  history: {
    accidents: "none" | "minor-damage";
    owners: "1" | "2" | "3+";
    personalUse: boolean;
    serviceHistory: boolean;
    serviceRecords?: number;
  };
  image: string;
  tagline: string;
};

export const CARS: Car[] = [
  {
    slug: "2023-bmw-m5",
    year: 2023, make: "BMW", model: "M5", price: 83995, miles: 30158,
    body: "Sedan", mpg: "15/21", drive: "AWD", trans: "Automatic", engine: "8 Cyl",
    exterior: "Gray", interior: "Black",
    vin: "WBS83CH00PCM91400",
    carfaxUrl: "https://www.carfax.com/vehicle/WBS83CH00PCM91400",
    dealerCity: "Newport Beach, CA", belowValue: 4985,
    history: { accidents: "none", owners: "1", personalUse: true, serviceHistory: true, serviceRecords: 10 },
    image: "/cars/bmw-m5.jpg",
    tagline: "A business suit wrapped around a missile.",
  },
  {
    slug: "2024-bmw-m4-competition",
    year: 2024, make: "BMW", model: "M4", trim: "Competition", price: 70237, miles: 27575,
    body: "Coupe", mpg: "16/23", drive: "RWD", trans: "Automatic", engine: "6 Cyl",
    exterior: "Gray", interior: "Orange",
    vin: "WBS33AZ05RCP65741",
    carfaxUrl: "https://www.carfax.com/vehicle/WBS33AZ05RCP65741",
    dealerCity: "Van Nuys, CA", belowValue: 3553,
    history: { accidents: "none", owners: "1", personalUse: true, serviceHistory: true },
    image: "/cars/m4-comp.jpg",
    tagline: "Grilles you can see from space. Pace to match.",
  },
  {
    slug: "2023-mercedes-amg-gt-63",
    year: 2023, make: "Mercedes-Benz", model: "AMG GT 63", price: 116900, miles: 8544,
    body: "Coupe", mpg: "15/21", drive: "AWD", trans: "Automatic", engine: "8 Cyl",
    exterior: "Black", interior: "Black",
    vin: "W1K7X8JB0PA063246",
    carfaxUrl: "https://www.carfax.com/vehicle/W1K7X8JB0PA063246",
    dealerCity: "Newport Beach, CA", belowValue: 22035,
    history: { accidents: "none", owners: "1", personalUse: true, serviceHistory: true },
    image: "/cars/amg-gtr.jpg",
    tagline: "Four doors of thunder from Affalterbach.",
  },
  {
    slug: "2026-porsche-panamera-gts",
    year: 2026, make: "Porsche", model: "Panamera", trim: "GTS", price: 184888, miles: 2998,
    body: "Sedan", mpg: "—", drive: "AWD", trans: "Automatic", engine: "8 Cyl",
    exterior: "White", interior: "Black",
    vin: "WP0AG2YA6TL070517",
    carfaxUrl: "https://www.carfax.com/vehicle/WP0AG2YA6TL070517",
    dealerCity: "Pasadena, CA", certified: true,
    history: { accidents: "none", owners: "1", personalUse: true, serviceHistory: true },
    image: "/cars/panamera.jpg",
    tagline: "Certified, nearly new, and very fast.",
  },
  {
    slug: "2018-chevrolet-camaro-ss",
    year: 2018, make: "Chevrolet", model: "Camaro SS", trim: "1SS", price: 29585, miles: 75217,
    body: "Coupe", mpg: "17/27", drive: "RWD", trans: "Automatic", engine: "8 Cyl",
    exterior: "Black", interior: "Black",
    vin: "1G1FF1R75J0189690",
    carfaxUrl: "https://www.carfax.com/vehicle/1G1FF1R75J0189690",
    dealerCity: "North Hollywood, CA",
    history: { accidents: "minor-damage", owners: "3+", personalUse: true, serviceHistory: true },
    image: "/cars/camaro-ss.jpg",
    tagline: "Honest muscle — with an honest history. Ask the Fox.",
  },
  {
    slug: "2015-ford-mustang-gt",
    year: 2015, make: "Ford", model: "Mustang GT", price: 18988, miles: 93055,
    body: "Coupe", mpg: "15/25", drive: "RWD", trans: "Manual", engine: "8 Cyl",
    exterior: "White", interior: "Black",
    vin: "1FA6P8CF6F5370519",
    carfaxUrl: "https://www.carfax.com/vehicle/1FA6P8CF6F5370519",
    dealerCity: "Bell, CA",
    history: { accidents: "none", owners: "3+", personalUse: true, serviceHistory: true },
    image: "/cars/mustang-gt.jpg",
    tagline: "5.0 V8, three pedals, zero excuses.",
  },
];

export const money = (n: number) => "$" + n.toLocaleString("en-US");
export const km = (n: number) => n.toLocaleString("en-US") + " mi";
export const getCar = (slug: string) => CARS.find((c) => c.slug === slug);

/** Compact inventory brief — used to keep the Car Fox agent's knowledge in sync. */
export const inventoryBrief = () =>
  CARS.map((c) => {
    const h = c.history;
    return `${c.year} ${c.make} ${c.model}${c.trim ? " " + c.trim : ""} — ${money(c.price)}, ${km(
      c.miles
    )}, VIN ${c.vin}, ${c.exterior}/${c.interior}, ${c.engine} ${c.trans} ${c.drive}, MPG ${c.mpg}, ${
      h.accidents === "none" ? "no accidents reported" : "minor damage reported"
    }, ${h.owners} owner(s), ${h.personalUse ? "personal use" : "fleet"}, ${
      h.serviceHistory ? "service history on file" : "no service records"
    }${c.certified ? ", certified pre-owned" : ""}, dealer: ${c.dealerCity}`;
  }).join("\n");
