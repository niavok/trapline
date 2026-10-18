// Downloads the Ile-de-France OpenStreetMap extract from Geofabrik (~300 MB).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { PATHS } from "./common";

const URL = "https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf";

if (existsSync(PATHS.pbf) && !process.argv.includes("--force")) {
  console.log(`${PATHS.pbf} already there (${(statSync(PATHS.pbf).size / 1e6).toFixed(0)} MB), use --force to refresh`);
} else {
  mkdirSync(dirname(PATHS.pbf), { recursive: true });
  console.log(`downloading ${URL} ...`);
  const response = await fetch(URL);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const tmp = `${PATHS.pbf}.part`;
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(tmp));
  renameSync(tmp, PATHS.pbf);
  console.log(`saved ${PATHS.pbf} (${(statSync(PATHS.pbf).size / 1e6).toFixed(0)} MB)`);
}
