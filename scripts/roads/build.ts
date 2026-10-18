// Builds data/roads/idf-roads.bin from the OSM extract.
// Usage: npm run roads:build [-- --no-local]   (--no-local drops residential streets)
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildRoadGraph } from "../../src/lib/roads/build";
import { HIGHWAY_TO_GROUP, type RoadGroup } from "../../src/lib/roads/classes";
import { serializeRoadGraph } from "../../src/lib/roads/format";
import { pbfSource } from "../../src/lib/roads/pbfSource";
import { PATHS } from "./common";

if (!existsSync(PATHS.pbf)) throw new Error(`${PATHS.pbf} not found: run "npm run roads:download" first`);

const highways: Record<string, RoadGroup> = { ...HIGHWAY_TO_GROUP };
if (process.argv.includes("--no-local")) {
  for (const [k, g] of Object.entries(highways)) if (g === "local") delete highways[k];
}

const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(0)}s`;
const { graph, stats } = await buildRoadGraph(pbfSource(PATHS.pbf), {
  highways,
  onProgress: (m) => console.log(`[${elapsed()}] ${m}`),
});
mkdirSync(dirname(PATHS.graph), { recursive: true });
writeFileSync(PATHS.graph, serializeRoadGraph(graph));

console.log(`\ndone in ${elapsed()}`);
console.log(JSON.stringify(stats, null, 2));
console.log(`${PATHS.graph}: ${(statSync(PATHS.graph).size / 1e6).toFixed(1)} MB`);
console.log(`peak memory (rss): ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
