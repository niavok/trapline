import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_DRIVE_PARAMS, type DriveParams } from "../../src/lib/roads/classes";
import { deserializeRoadGraph } from "../../src/lib/roads/format";
import { RoadGraph } from "../../src/lib/roads/graph";
import type { ReferenceTrip } from "../../src/lib/roads/calibrate";
import type { LatLng } from "../../src/lib/geo/geo";

export const PATHS = {
  pbf: "data/osm/ile-de-france-latest.osm.pbf",
  graph: "data/roads/idf-roads.bin",
  params: "data/roads/drive-params.json",
  places: "data/roads/places.json",
  trips: "data/roads/reference-trips.json",
};

export interface Place extends LatLng {
  name: string;
}

export interface TripFile {
  /** Trips by place names (from places.json), or by coordinates. */
  trips: { from: string | LatLng; to: string | LatLng; minutes: number | null; source?: string }[];
}

export function loadGraph(): RoadGraph {
  if (!existsSync(PATHS.graph)) throw new Error(`${PATHS.graph} not found: run "npm run roads:build" first`);
  const started = performance.now();
  const data = deserializeRoadGraph(readFileSync(PATHS.graph));
  const graph = new RoadGraph(data, loadParams());
  console.log(`graph loaded in ${Math.round(performance.now() - started)} ms`);
  return graph;
}

export function loadParams(): DriveParams {
  return existsSync(PATHS.params) ? (JSON.parse(readFileSync(PATHS.params, "utf8")) as DriveParams) : DEFAULT_DRIVE_PARAMS;
}

export function loadPlaces(): Place[] {
  if (!existsSync(PATHS.places)) throw new Error(`${PATHS.places} not found: copy places.example.json and fill it`);
  return JSON.parse(readFileSync(PATHS.places, "utf8")) as Place[];
}

/** Reference trips with a known duration, place names resolved. */
export function loadTrips(): ReferenceTrip[] {
  if (!existsSync(PATHS.trips)) return [];
  const places = existsSync(PATHS.places) ? loadPlaces() : [];
  const resolve = (p: string | LatLng): LatLng => {
    if (typeof p !== "string") return p;
    const place = places.find((x) => x.name === p);
    if (!place) throw new Error(`Unknown place "${p}" in ${PATHS.trips}`);
    return place;
  };
  const file = JSON.parse(readFileSync(PATHS.trips, "utf8")) as TripFile;
  return file.trips
    .filter((t) => typeof t.minutes === "number")
    .map((t) => ({
      label: `${typeof t.from === "string" ? t.from : "?"} -> ${typeof t.to === "string" ? t.to : "?"}${t.source ? ` (${t.source})` : ""}`,
      from: resolve(t.from),
      to: resolve(t.to),
      minutes: t.minutes!,
    }));
}

export const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "  -  " : v.toFixed(1).padStart(5));
