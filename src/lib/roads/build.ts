import { haversineKm } from "@/lib/geo/geo";
import { HIGHWAY_TO_GROUP, ROAD_GROUPS, type RoadGroup } from "./classes";
import type { OsmSource, OsmWay, RoadGraphData } from "./types";

export interface BuildOptions {
  /** OSM highway values to keep, with their group. */
  highways?: Readonly<Record<string, RoadGroup>>;
  onProgress?: (message: string) => void;
}

export interface BuildStats {
  keptWays: number;
  referencedNodes: number;
  graphNodes: number;
  edges: number;
  droppedNodesOutsideMainComponent: number;
}

const FORWARD = 1;
const BACKWARD = -1;
const BOTH = 0;

interface KeptWay {
  refs: number[];
  group: number;
  direction: number;
}

/**
 * Builds a compact directed driving graph: only junctions and way ends become
 * nodes, the geometry in between is folded into edge length and traffic-light
 * counts. Keeps the largest strongly connected component, so that any snapped
 * point can reach any other.
 */
export async function buildRoadGraph(
  source: OsmSource,
  options: BuildOptions = {},
): Promise<{ graph: RoadGraphData; stats: BuildStats }> {
  const highways = options.highways ?? HIGHWAY_TO_GROUP;
  const log = options.onProgress ?? (() => {});

  // Pass 1: ways.
  const ways: KeptWay[] = [];
  const allRefs: number[] = [];
  for await (const way of source.ways()) {
    const kept = keepWay(way, highways);
    if (!kept) continue;
    ways.push(kept);
    for (const ref of kept.refs) allRefs.push(ref);
    if (ways.length % 100_000 === 0) log(`ways kept: ${ways.length}`);
  }
  log(`ways kept: ${ways.length}, node references: ${allRefs.length}`);

  // Unique referenced node ids (sorted) and how many times each is used.
  const sorted = Float64Array.from(allRefs).sort();
  allRefs.length = 0;
  const ids: number[] = [];
  const uses: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] === sorted[i - 1]) uses[uses.length - 1]!++;
    else {
      ids.push(sorted[i]!);
      uses.push(1);
    }
  }
  const uniqueIds = Float64Array.from(ids);
  const indexOf = (id: number): number => {
    let lo = 0;
    let hi = uniqueIds.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = uniqueIds[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const isGraphNode = new Uint8Array(uniqueIds.length);
  uses.forEach((count, i) => {
    if (count >= 2) isGraphNode[i] = 1;
  });
  for (const way of ways) {
    isGraphNode[indexOf(way.refs[0]!)] = 1;
    isGraphNode[indexOf(way.refs[way.refs.length - 1]!)] = 1;
  }

  // Pass 2: coordinates and traffic lights of referenced nodes.
  const lat = new Float64Array(uniqueIds.length).fill(NaN);
  const lng = new Float64Array(uniqueIds.length).fill(NaN);
  const signal = new Uint8Array(uniqueIds.length);
  let seen = 0;
  for await (const node of source.nodes()) {
    const i = indexOf(node.id);
    if (i < 0) continue;
    lat[i] = node.lat;
    lng[i] = node.lon;
    if (node.tags?.highway === "traffic_signals") signal[i] = 1;
    if (++seen % 1_000_000 === 0) log(`nodes located: ${seen}`);
  }
  // A missing node (way crossing the extract border) cuts the way there.
  for (let i = 0; i < uniqueIds.length; i++) if (Number.isNaN(lat[i]!)) isGraphNode[i] = 1;

  const graphIndex = new Int32Array(uniqueIds.length).fill(-1);
  let graphNodes = 0;
  for (let i = 0; i < uniqueIds.length; i++) if (isGraphNode[i] && !Number.isNaN(lat[i]!)) graphIndex[i] = graphNodes++;

  // Edges between consecutive graph nodes of each way.
  const from: number[] = [];
  const to: number[] = [];
  const meters: number[] = [];
  const group: number[] = [];
  const signalsBetween: number[] = [];
  const addEdge = (a: number, b: number, m: number, g: number, s: number) => {
    if (a === b) return;
    from.push(a);
    to.push(b);
    meters.push(m);
    group.push(g);
    signalsBetween.push(s);
  };
  for (const way of ways) {
    let start = -1;
    let length = 0;
    let lights = 0;
    let prev = -1;
    for (const ref of way.refs) {
      const i = indexOf(ref);
      if (Number.isNaN(lat[i]!)) {
        start = -1;
        prev = -1;
        continue;
      }
      if (prev >= 0) length += haversineKm({ lat: lat[prev]!, lng: lng[prev]! }, { lat: lat[i]!, lng: lng[i]! }) * 1000;
      if (graphIndex[i]! >= 0) {
        if (start >= 0) {
          const a = graphIndex[start]!;
          const b = graphIndex[i]!;
          if (way.direction !== BACKWARD) addEdge(a, b, length, way.group, lights + signal[i]!);
          if (way.direction !== FORWARD) addEdge(b, a, length, way.group, lights + signal[start]!);
        }
        start = i;
        length = 0;
        lights = 0;
      } else {
        lights += signal[i]!;
      }
      prev = i;
    }
  }
  log(`graph nodes: ${graphNodes}, edges: ${from.length}`);

  const nodeLat = new Float64Array(graphNodes);
  const nodeLng = new Float64Array(graphNodes);
  for (let i = 0; i < uniqueIds.length; i++) {
    const g = graphIndex[i]!;
    if (g >= 0) {
      nodeLat[g] = lat[i]!;
      nodeLng[g] = lng[i]!;
    }
  }

  const component = largestStronglyConnectedComponent(graphNodes, from, to);
  const remap = new Int32Array(graphNodes).fill(-1);
  let kept = 0;
  for (let i = 0; i < graphNodes; i++) if (component[i]) remap[i] = kept++;

  const graph = toCsr(kept, nodeLat, nodeLng, remap, from, to, meters, group, signalsBetween);
  log(`main component: ${kept} nodes, ${graph.edgeTarget.length} edges`);
  return {
    graph,
    stats: {
      keptWays: ways.length,
      referencedNodes: uniqueIds.length,
      graphNodes: kept,
      edges: graph.edgeTarget.length,
      droppedNodesOutsideMainComponent: graphNodes - kept,
    },
  };
}

function keepWay(way: OsmWay, highways: Readonly<Record<string, RoadGroup>>): KeptWay | null {
  const tags = way.tags ?? {};
  const groupName = highways[tags.highway ?? ""];
  if (!groupName || way.refs.length < 2) return null;
  if (tags.area === "yes") return null;
  const motor = tags.motor_vehicle ?? tags.motorcar;
  if (motor === "no" || motor === "private") return null;
  if ((tags.access === "no" || tags.access === "private") && motor !== "yes" && motor !== "destination") return null;

  let direction = BOTH;
  const oneway = tags.oneway;
  if (oneway === "yes" || oneway === "true" || oneway === "1") direction = FORWARD;
  else if (oneway === "-1" || oneway === "reverse") direction = BACKWARD;
  else if (oneway !== "no" && (tags.junction === "roundabout" || tags.junction === "circular" || tags.highway === "motorway")) {
    direction = FORWARD;
  }
  return { refs: way.refs, group: ROAD_GROUPS.indexOf(groupName), direction };
}

/** Iterative Tarjan; returns a 0/1 membership array of the largest SCC. */
function largestStronglyConnectedComponent(n: number, from: number[], to: number[]): Uint8Array {
  const start = new Uint32Array(n + 1);
  for (const a of from) start[a + 1]!++;
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
  const adj = new Uint32Array(from.length);
  const fill = start.slice(0, n);
  from.forEach((a, e) => (adj[fill[a]!++] = to[e]!));

  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    callNode.push(root);
    callEdge.push(start[root]!);
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (callNode.length > 0) {
      const v = callNode[callNode.length - 1]!;
      const e = callEdge[callEdge.length - 1]!;
      if (e < start[v + 1]!) {
        callEdge[callEdge.length - 1] = e + 1;
        const w = adj[e]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          callNode.push(w);
          callEdge.push(start[w]!);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      callNode.pop();
      callEdge.pop();
      if (callNode.length > 0) {
        const parent = callNode[callNode.length - 1]!;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const id = sizes.length;
        let size = 0;
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = id;
          size++;
        } while (w !== v);
        sizes.push(size);
      }
    }
  }

  let best = 0;
  sizes.forEach((s, i) => {
    if (s > sizes[best]!) best = i;
  });
  const member = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (comp[i] === best) member[i] = 1;
  return member;
}

function toCsr(
  n: number,
  oldLat: Float64Array,
  oldLng: Float64Array,
  remap: Int32Array,
  from: number[],
  to: number[],
  meters: number[],
  group: number[],
  signals: number[],
): RoadGraphData {
  const nodeLat = new Float64Array(n);
  const nodeLng = new Float64Array(n);
  remap.forEach((r, i) => {
    if (r >= 0) {
      nodeLat[r] = oldLat[i]!;
      nodeLng[r] = oldLng[i]!;
    }
  });

  const keptEdges: number[] = [];
  for (let e = 0; e < from.length; e++) if (remap[from[e]!]! >= 0 && remap[to[e]!]! >= 0) keptEdges.push(e);

  // Junction = node with 3+ distinct neighbours (either direction).
  const neighbours = Array.from({ length: n }, () => new Set<number>());
  for (const e of keptEdges) {
    const a = remap[from[e]!]!;
    const b = remap[to[e]!]!;
    neighbours[a]!.add(b);
    neighbours[b]!.add(a);
  }

  const edgeStart = new Uint32Array(n + 1);
  for (const e of keptEdges) edgeStart[remap[from[e]!]! + 1]!++;
  for (let i = 0; i < n; i++) edgeStart[i + 1]! += edgeStart[i]!;
  const fill = edgeStart.slice(0, n);
  const m = keptEdges.length;
  const edgeTarget = new Uint32Array(m);
  const edgeMeters = new Float32Array(m);
  const edgeGroup = new Uint8Array(m);
  const edgeSignals = new Uint8Array(m);
  const edgeJunction = new Uint8Array(m);
  for (const e of keptEdges) {
    const a = remap[from[e]!]!;
    const b = remap[to[e]!]!;
    const slot = fill[a]!++;
    edgeTarget[slot] = b;
    edgeMeters[slot] = meters[e]!;
    edgeGroup[slot] = group[e]!;
    edgeSignals[slot] = Math.min(255, signals[e]!);
    edgeJunction[slot] = neighbours[b]!.size >= 3 ? 1 : 0;
  }
  return { nodeLat, nodeLng, edgeStart, edgeTarget, edgeMeters, edgeGroup, edgeSignals, edgeJunction };
}
