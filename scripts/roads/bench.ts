// Measures the graph (load time, Dijkstra speed) and compares its drive times
// with the reference trips. Usage: npm run roads:bench
import { existsSync } from "node:fs";
import { PATHS, fmt, loadGraph, loadPlaces, loadTrips } from "./common";

const graph = loadGraph();
console.log(`nodes: ${graph.nodeCount}, edges: ${graph.data.edgeTarget.length}`);

let started = performance.now();
const runs = 20;
for (let i = 0; i < runs; i++) graph.shortestFrom(Math.floor((i * graph.nodeCount) / runs));
console.log(`full Dijkstra: ${((performance.now() - started) / runs).toFixed(0)} ms per source`);

if (existsSync(PATHS.places)) {
  const places = loadPlaces();
  started = performance.now();
  const matrix = graph.driveMatrix(places);
  console.log(`\n${places.length}x${places.length} drive matrix in ${Math.round(performance.now() - started)} ms (minutes):`);
  const names = places.map((p) => p.name.slice(0, 10).padEnd(10));
  console.log(`${"".padEnd(12)}${names.join(" ")}`);
  matrix.forEach((row, i) => console.log(`${names[i]}  ${row.map((v) => fmt(v).padStart(10)).join(" ")}`));
  const far = places.map((p) => graph.nearestNode(p)!).filter((s) => s.km > 0.3);
  if (far.length > 0) console.log(`warning: ${far.length} place(s) more than 300 m away from the graph`);
}

const trips = loadTrips();
if (trips.length > 0) {
  console.log(`\nreference trips (minutes): actual vs graph`);
  let sum = 0;
  for (const t of trips) {
    const predicted = graph.driveMatrix([t.from, t.to])[0]![1] ?? null;
    if (predicted !== null) sum += Math.abs(predicted - t.minutes);
    console.log(`${fmt(t.minutes)} ${fmt(predicted)}  ${t.label}`);
  }
  console.log(`mean absolute error: ${(sum / trips.length).toFixed(1)} min`);
}
