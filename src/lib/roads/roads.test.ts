import { describe, expect, it } from "vitest";
import { haversineKm, type LatLng } from "@/lib/geo/geo";
import { mulberry32 } from "@/lib/solver/testUtils";
import { buildRoadGraph } from "./build";
import { calibrate } from "./calibrate";
import { DEFAULT_DRIVE_PARAMS, ROAD_GROUPS, groupIndex, type DriveParams } from "./classes";
import { deserializeRoadGraph, serializeRoadGraph } from "./format";
import { RoadGraph } from "./graph";
import type { OsmNode, OsmSource, OsmWay, RoadGraphData } from "./types";

// Synthetic town: SIZE x SIZE intersections ~300 m apart. Each street segment
// has a shape node in its middle (to be folded away). Row 0 is a primary
// avenue, column 0 a one-way trunk going north, the rest residential.
const SIZE = 6;
const STEP = 0.003;
const ORIGIN = { lat: 48.8, lng: 2.3 };
const crossingId = (r: number, c: number) => 1 + r * SIZE + c;

function town(): { nodes: OsmNode[]; ways: OsmWay[] } {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  let nextId = 10_000;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const tags = r === 2 && c === 2 ? { highway: "traffic_signals" } : undefined;
      nodes.push({ id: crossingId(r, c), lat: ORIGIN.lat + r * STEP, lon: ORIGIN.lng + c * STEP, tags });
    }
  }
  const segment = (a: [number, number], b: [number, number], tags: Record<string, string>) => {
    const mid = nextId++;
    nodes.push({
      id: mid,
      lat: ORIGIN.lat + ((a[0] + b[0]) / 2) * STEP,
      lon: ORIGIN.lng + ((a[1] + b[1]) / 2) * STEP,
    });
    ways.push({ id: nextId++, refs: [crossingId(...a), mid, crossingId(...b)], tags });
  };
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c + 1 < SIZE; c++) segment([r, c], [r, c + 1], { highway: r === 0 ? "primary" : "residential" });
  }
  for (let c = 0; c < SIZE; c++) {
    for (let r = 0; r + 1 < SIZE; r++) {
      segment([r, c], [r + 1, c], c === 0 ? { highway: "trunk", oneway: "yes" } : { highway: "residential" });
    }
  }
  // Noise that must be dropped: a footway, a private road, an isolated road.
  nodes.push({ id: 900, lat: 48.9, lon: 2.4 }, { id: 901, lat: 48.901, lon: 2.401 });
  ways.push({ id: 1, refs: [crossingId(0, 0), crossingId(5, 5)], tags: { highway: "footway" } });
  ways.push({ id: 2, refs: [crossingId(0, 0), crossingId(5, 5)], tags: { highway: "residential", access: "private" } });
  ways.push({ id: 3, refs: [900, 901], tags: { highway: "residential" } });
  return { nodes, ways };
}

function source(data: { nodes: OsmNode[]; ways: OsmWay[] }): OsmSource {
  return {
    async *ways() {
      yield* data.ways;
    },
    async *nodes() {
      yield* data.nodes;
    },
  };
}

const crossing = (r: number, c: number): LatLng => ({ lat: ORIGIN.lat + r * STEP, lng: ORIGIN.lng + c * STEP });

describe("buildRoadGraph", async () => {
  const { graph, stats } = await buildRoadGraph(source(town()));
  const nodeAt = (r: number, c: number) => {
    const p = crossing(r, c);
    for (let i = 0; i < graph.nodeLat.length; i++) {
      if (Math.abs(graph.nodeLat[i]! - p.lat) < 1e-9 && Math.abs(graph.nodeLng[i]! - p.lng) < 1e-9) return i;
    }
    throw new Error("missing node");
  };
  const edgesBetween = (a: number, b: number) => {
    const found: number[] = [];
    for (let e = graph.edgeStart[a]!; e < graph.edgeStart[a + 1]!; e++) if (graph.edgeTarget[e] === b) found.push(e);
    return found;
  };

  it("keeps only intersections as nodes, in the main component", () => {
    expect(graph.nodeLat.length).toBe(SIZE * SIZE);
    expect(stats.droppedNodesOutsideMainComponent).toBe(2);
    // 2 directions per street segment, minus the one-way trunk column.
    const segments = 2 * SIZE * (SIZE - 1);
    expect(graph.edgeTarget.length).toBe(2 * segments - (SIZE - 1));
  });

  it("folds shape nodes into lengths and respects one-way streets", () => {
    const [e] = edgesBetween(nodeAt(1, 1), nodeAt(1, 2));
    expect(graph.edgeMeters[e!]).toBeCloseTo(haversineKm(crossing(1, 1), crossing(1, 2)) * 1000, 0);
    expect(edgesBetween(nodeAt(0, 0), nodeAt(1, 0))).toHaveLength(1);
    expect(edgesBetween(nodeAt(1, 0), nodeAt(0, 0))).toHaveLength(0);
    expect(graph.edgeGroup[edgesBetween(nodeAt(0, 0), nodeAt(1, 0))[0]!]).toBe(groupIndex("trunk"));
    expect(graph.edgeGroup[edgesBetween(nodeAt(0, 1), nodeAt(0, 2))[0]!]).toBe(groupIndex("primary"));
  });

  it("counts traffic lights and junctions at the target", () => {
    expect(graph.edgeSignals[edgesBetween(nodeAt(2, 1), nodeAt(2, 2))[0]!]).toBe(1);
    expect(graph.edgeSignals[edgesBetween(nodeAt(2, 2), nodeAt(2, 1))[0]!]).toBe(0);
    expect(graph.edgeJunction[edgesBetween(nodeAt(2, 1), nodeAt(2, 2))[0]!]).toBe(1);
    expect(graph.edgeJunction[edgesBetween(nodeAt(0, 1), nodeAt(0, 0))[0]!]).toBe(0); // corner
  });

  it("round-trips through the binary format", () => {
    const back = deserializeRoadGraph(serializeRoadGraph(graph));
    expect(back.edgeTarget).toEqual(graph.edgeTarget);
    expect(back.edgeGroup).toEqual(graph.edgeGroup);
    expect(back.edgeMeters).toEqual(graph.edgeMeters);
    back.nodeLat.forEach((v, i) => expect(v).toBeCloseTo(graph.nodeLat[i]!, 5));
  });
});

describe("RoadGraph", async () => {
  const { graph: data } = await buildRoadGraph(source(town()));
  const roads = new RoadGraph(data);

  it("finds the same shortest times as Bellman-Ford", () => {
    const reference = bellmanFord(data, 0, (e) => roadWeight(data, e, DEFAULT_DRIVE_PARAMS));
    const { dist } = roads.shortestFrom(0);
    dist.forEach((d, i) => expect(d).toBeCloseTo(reference[i]!, 4));
  });

  it("snaps points to the truly nearest node", () => {
    const rand = mulberry32(5);
    for (let k = 0; k < 50; k++) {
      const p = { lat: 48.79 + rand() * 0.04, lng: 2.29 + rand() * 0.04 };
      const snap = roads.nearestNode(p)!;
      let best = Infinity;
      for (let i = 0; i < data.nodeLat.length; i++) {
        best = Math.min(best, haversineKm(p, { lat: data.nodeLat[i]!, lng: data.nodeLng[i]! }));
      }
      expect(snap.km).toBeCloseTo(best, 9);
    }
  });

  it("builds an asymmetric drive matrix (one-way trunk)", () => {
    const m = roads.driveMatrix([crossing(0, 0), crossing(5, 0)]);
    expect(m[0]![0]).toBe(0);
    expect(m[0]![1]).toBeLessThan(m[1]![0]!);
  });

  it("recovers drive parameters from observed trips", () => {
    const truth: DriveParams = {
      ...DEFAULT_DRIVE_PARAMS,
      minutesPerKm: ROAD_GROUPS.map((_, i) => DEFAULT_DRIVE_PARAMS.minutesPerKm[i]! * (i % 2 === 0 ? 1.4 : 0.8)),
      signalMinutes: 1,
    };
    const observer = new RoadGraph(data, truth);
    const rand = mulberry32(9);
    const trips = Array.from({ length: 25 }, () => {
      const from = crossing(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE));
      const to = crossing(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE));
      return { from, to, minutes: observer.driveMatrix([from, to])[0]![1]! };
    }).filter((t) => t.from.lat !== t.to.lat || t.from.lng !== t.to.lng);

    const result = calibrate(new RoadGraph(data), trips, { priorWeight: 0.01 });

    expect(result.meanAbsErrorBefore).toBeGreaterThan(0.5);
    expect(result.meanAbsErrorAfter).toBeLessThan(0.1);
  });
});

function roadWeight(g: RoadGraphData, e: number, p: DriveParams): number {
  return (
    (g.edgeMeters[e]! / 1000) * p.minutesPerKm[g.edgeGroup[e]!]! +
    g.edgeSignals[e]! * p.signalMinutes +
    g.edgeJunction[e]! * p.junctionMinutes
  );
}

function bellmanFord(g: RoadGraphData, source: number, weight: (e: number) => number): number[] {
  const n = g.nodeLat.length;
  const dist = new Array<number>(n).fill(Infinity);
  dist[source] = 0;
  for (let round = 0; round < n; round++) {
    for (let v = 0; v < n; v++) {
      for (let e = g.edgeStart[v]!; e < g.edgeStart[v + 1]!; e++) {
        const w = g.edgeTarget[e]!;
        dist[w] = Math.min(dist[w]!, dist[v]! + weight(e));
      }
    }
  }
  return dist;
}
