// Optional: measures drive times between all places with Google Routes
// (computeRoutes, traffic aware) and stores them as reference trips.
// Needs GOOGLE_MAPS_API_KEY. n places = n x (n - 1) calls: 10 places = 90
// calls, inside the monthly free tier of the Pro SKU.
// Usage: GOOGLE_MAPS_API_KEY=... npm run roads:sample -- [--departure 2026-10-24T11:00:00+02:00]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PATHS, loadPlaces, type TripFile } from "./common";

const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set");

const arg = process.argv.indexOf("--departure");
const departure = arg > 0 ? new Date(process.argv[arg + 1]!) : nextSaturdayAt11();
if (departure.getTime() <= Date.now()) throw new Error("departure must be in the future");

const places = loadPlaces();
const file: TripFile = existsSync(PATHS.trips) ? JSON.parse(readFileSync(PATHS.trips, "utf8")) : { trips: [] };
const source = `google ${departure.toISOString()}`;

for (const from of places) {
  for (const to of places) {
    if (from === to) continue;
    if (file.trips.some((t) => t.from === from.name && t.to === to.name && t.source === source)) continue;
    const minutes = await computeRouteMinutes(from, to);
    console.log(`${from.name} -> ${to.name}: ${minutes?.toFixed(1) ?? "no route"} min`);
    file.trips.push({ from: from.name, to: to.name, minutes, source });
    writeFileSync(PATHS.trips, JSON.stringify(file, null, 2));
  }
}

async function computeRouteMinutes(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const point = (p: { lat: number; lng: number }) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key!,
      "X-Goog-FieldMask": "routes.duration",
    },
    body: JSON.stringify({
      origin: point(from),
      destination: point(to),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      departureTime: departure.toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Routes API: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { routes?: { duration?: string }[] };
  const duration = body.routes?.[0]?.duration;
  return duration ? Number.parseInt(duration, 10) / 60 : null;
}

function nextSaturdayAt11(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  d.setUTCHours(9, 0, 0, 0); // 11:00 in Paris in summer, 10:00 in winter
  return d;
}
