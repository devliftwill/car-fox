// Car Fox demo inventory. Replace with real listings later.
const CARS = [
  { id: 1, year: 2021, make: "Toyota",    model: "RAV4 XLE",        price: 27950, miles: 31200, body: "SUV",       color: "#2f6fb2", owners: 1, accidents: 0, drivetrain: "AWD", trans: "Automatic", mpg: "27/34", vin: "2T3W1RFV8MC134901" },
  { id: 2, year: 2019, make: "Honda",     model: "Civic Sport",     price: 19480, miles: 42750, body: "Sedan",     color: "#c23b2e", owners: 2, accidents: 0, drivetrain: "FWD", trans: "CVT",       mpg: "30/38", vin: "19XFC2F86KE204417" },
  { id: 3, year: 2022, make: "Ford",      model: "F-150 Lariat",    price: 43990, miles: 18400, body: "Truck",     color: "#22343f", owners: 1, accidents: 0, drivetrain: "4WD", trans: "Automatic", mpg: "20/26", vin: "1FTFW1E85NFA10238" },
  { id: 4, year: 2020, make: "Subaru",    model: "Outback Premium", price: 24700, miles: 38900, body: "Wagon",     color: "#4a7c59", owners: 1, accidents: 1, drivetrain: "AWD", trans: "CVT",       mpg: "26/33", vin: "4S4BTACC3L3142276" },
  { id: 5, year: 2023, make: "Tesla",     model: "Model 3 RWD",     price: 33200, miles: 12100, body: "Sedan",     color: "#8a8f98", owners: 1, accidents: 0, drivetrain: "RWD", trans: "1-speed",   mpg: "132 MPGe", vin: "5YJ3E1EA8PF412009" },
  { id: 6, year: 2018, make: "Jeep",      model: "Wrangler Sahara", price: 28900, miles: 51600, body: "SUV",       color: "#b58a3c", owners: 2, accidents: 0, drivetrain: "4WD", trans: "Automatic", mpg: "18/23", vin: "1C4HJXEG4JW140552" },
];

function money(n){ return "$" + n.toLocaleString("en-US"); }
function kmiles(n){ return n.toLocaleString("en-US") + " mi"; }

// Simple, consistent car illustration (side profile) tinted per vehicle.
function carSVG(color, wide){
  const w = wide ? 640 : 420, h = wide ? 400 : 300;
  return `
  <svg viewBox="0 0 420 300" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img">
    <defs>
      <linearGradient id="sky${color.replace('#','')}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".14"/>
        <stop offset="1" stop-color="${color}" stop-opacity=".04"/>
      </linearGradient>
    </defs>
    <rect width="420" height="300" fill="url(#sky${color.replace('#','')})"/>
    <ellipse cx="210" cy="238" rx="150" ry="12" fill="rgba(0,0,0,.10)"/>
    <g>
      <path d="M78 210 q-10 -2 -10 -14 q0 -18 26 -22 q30 -34 78 -40 q60 -8 104 10 q20 8 34 26 q36 4 44 18 q6 10 2 22 q-4 8 -14 8 l-8 0 a30 30 0 0 0 -58 2 l-124 0 a30 30 0 0 0 -58 2 z" fill="${color}"/>
      <path d="M148 152 q28 -14 62 -14 l6 40 l-96 2 q10 -18 28 -28 z" fill="#dff0fa"/>
      <path d="M228 138 q34 2 58 18 q8 6 12 14 l-64 2 z" fill="#dff0fa"/>
      <circle cx="136" cy="240" r="26" fill="#20262b"/><circle cx="136" cy="240" r="12" fill="#aab4bd"/>
      <circle cx="318" cy="240" r="26" fill="#20262b"/><circle cx="318" cy="240" r="12" fill="#aab4bd"/>
    </g>
  </svg>`;
}
