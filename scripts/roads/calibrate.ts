// Fits the drive time model to the reference trips and writes
// data/roads/drive-params.json. Usage: npm run roads:calibrate [-- --prior-weight 2]
import { writeFileSync } from "node:fs";
import { calibrate } from "../../src/lib/roads/calibrate";
import { ROAD_GROUPS } from "../../src/lib/roads/classes";
import { PATHS, fmt, loadGraph, loadTrips } from "./common";

const trips = loadTrips();
if (trips.length < 5) throw new Error(`only ${trips.length} trips with minutes in ${PATHS.trips}, need at least 5`);

const arg = process.argv.indexOf("--prior-weight");
const priorWeight = arg > 0 ? Number(process.argv[arg + 1]) : 2;

const graph = loadGraph();
const result = calibrate(graph, trips, { priorWeight });

console.log(`\nactual  before  after   trip`);
for (const t of result.trips) console.log(`${fmt(t.actual)}  ${fmt(t.before)}  ${fmt(t.after)}   ${t.label}`);
console.log(`\nmean absolute error: ${result.meanAbsErrorBefore.toFixed(1)} -> ${result.meanAbsErrorAfter.toFixed(1)} min`);
console.log(`\neffective speeds:`);
ROAD_GROUPS.forEach((g, i) => console.log(`  ${g.padEnd(10)} ${(60 / result.params.minutesPerKm[i]!).toFixed(0)} km/h`));
console.log(`  traffic light ${(result.params.signalMinutes * 60).toFixed(0)} s, junction ${(result.params.junctionMinutes * 60).toFixed(0)} s, fixed ${result.params.fixedMinutes.toFixed(1)} min`);

writeFileSync(PATHS.params, JSON.stringify(result.params, null, 2));
console.log(`\nwritten ${PATHS.params}`);
