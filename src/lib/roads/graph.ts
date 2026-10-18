import { haversineKm, type LatLng } from "@/lib/geo/geo";
import { DEFAULT_DRIVE_PARAMS, ROAD_GROUPS, type DriveParams } from "./classes";
import type { RoadGraphData } from "./types";

const CELL_DEG = 0.01;

/** Per-path quantities that the drive time model is linear in. */
export interface PathFeatures {
  kmByGroup: number[];
  signals: number;
  junctions: number;
}

export interface Snap {
  node: number;
  km: number;
}

/** Road graph with a driving-time model, nearest-node lookup and Dijkstra. */
export class RoadGraph {
  private weights: Float32Array;
  private readonly grid = new Map<string, number[]>();
  private params: DriveParams;

  constructor(
    readonly data: RoadGraphData,
    params: DriveParams = DEFAULT_DRIVE_PARAMS,
  ) {
    this.params = params;
    this.weights = this.computeWeights(params);
    for (let i = 0; i < data.nodeLat.length; i++) {
      const key = this.cellKey(Math.floor(data.nodeLat[i]! / CELL_DEG), Math.floor(data.nodeLng[i]! / CELL_DEG));
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    }
  }

  get nodeCount(): number {
    return this.data.nodeLat.length;
  }

  get driveParams(): DriveParams {
    return this.params;
  }

  setParams(params: DriveParams): void {
    this.params = params;
    this.weights = this.computeWeights(params);
  }

  /** Nearest graph node, searching rings of grid cells around the point. */
  nearestNode(p: LatLng): Snap | null {
    if (this.nodeCount === 0) return null;
    const ci = Math.floor(p.lat / CELL_DEG);
    const cj = Math.floor(p.lng / CELL_DEG);
    let best = null as Snap | null;
    // One cell is at least ~0.7 km wide in Ile-de-France.
    for (let ring = 0; ring < 200; ring++) {
      for (let i = ci - ring; i <= ci + ring; i++) {
        for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          for (const node of this.grid.get(this.cellKey(i, j)) ?? []) {
            const km = haversineKm(p, { lat: this.data.nodeLat[node]!, lng: this.data.nodeLng[node]! });
            if (!best || km < best.km) best = { node, km };
          }
        }
      }
      if (best && best.km < ring * CELL_DEG * 111 * 0.65) break;
    }
    return best;
  }

  /**
   * Dijkstra from `source`. Returns minutes to every node (Infinity when
   * unreachable) and, if asked, the edge used to reach each node.
   */
  shortestFrom(source: number, targets?: readonly number[], withParents = false) {
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const parentEdge = withParents ? new Int32Array(n).fill(-1) : null;
    const done = new Uint8Array(n);
    let remaining = targets ? new Set(targets).size : n;
    const wanted = targets ? new Uint8Array(n) : null;
    if (wanted) for (const t of targets!) wanted[t] = 1;

    const heap = new NodeHeap(1024);
    dist[source] = 0;
    heap.push(source, 0);
    const { edgeStart, edgeTarget } = this.data;
    while (heap.size > 0) {
      const v = heap.popNode();
      if (done[v]) continue;
      done[v] = 1;
      if (!wanted || wanted[v]) {
        if (--remaining === 0) break;
      }
      const dv = dist[v]!;
      for (let e = edgeStart[v]!; e < edgeStart[v + 1]!; e++) {
        const w = edgeTarget[e]!;
        const nd = dv + this.weights[e]!;
        if (nd < dist[w]!) {
          dist[w] = nd;
          if (parentEdge) parentEdge[w] = e;
          heap.push(w, nd);
        }
      }
    }
    return { dist, parentEdge };
  }

  /** Features of the current shortest path between two nodes (null if none). */
  pathFeatures(source: number, target: number): PathFeatures | null {
    const { dist, parentEdge } = this.shortestFrom(source, [target], true);
    if (!Number.isFinite(dist[target]!)) return null;
    const features: PathFeatures = { kmByGroup: ROAD_GROUPS.map(() => 0), signals: 0, junctions: 0 };
    const sourceOf = this.edgeSources();
    for (let v = target; v !== source; ) {
      const e = parentEdge![v]!;
      features.kmByGroup[this.data.edgeGroup[e]!]! += this.data.edgeMeters[e]! / 1000;
      features.signals += this.data.edgeSignals[e]!;
      features.junctions += this.data.edgeJunction[e]!;
      v = sourceOf[e]!;
    }
    return features;
  }

  /** Minutes to walk-drive from a point to its snapped node (or back). */
  accessMinutes(snap: Snap): number {
    return (snap.km / this.params.accessKmh) * 60;
  }

  /** Driving minutes between all points (null when no route). */
  driveMatrix(points: readonly LatLng[]): (number | null)[][] {
    const snaps = points.map((p) => this.nearestNode(p));
    const nodes = snaps.map((s) => s?.node ?? -1);
    return points.map((_, i) => {
      const from = snaps[i];
      if (!from) return points.map((_, j) => (i === j ? 0 : null));
      const { dist } = this.shortestFrom(from.node, nodes.filter((x) => x >= 0));
      return points.map((_, j) => {
        if (i === j) return 0;
        const to = snaps[j];
        if (!to) return null;
        const d = dist[to.node]!;
        if (!Number.isFinite(d)) return null;
        return this.params.fixedMinutes + this.accessMinutes(from) + d + this.accessMinutes(to);
      });
    });
  }

  private sources: Uint32Array | null = null;
  private edgeSources(): Uint32Array {
    if (!this.sources) {
      const { edgeStart } = this.data;
      const sources = new Uint32Array(this.data.edgeTarget.length);
      for (let v = 0; v < this.nodeCount; v++) {
        for (let e = edgeStart[v]!; e < edgeStart[v + 1]!; e++) sources[e] = v;
      }
      this.sources = sources;
    }
    return this.sources;
  }

  private computeWeights(params: DriveParams): Float32Array {
    const { edgeMeters, edgeGroup, edgeSignals, edgeJunction } = this.data;
    const weights = new Float32Array(edgeMeters.length);
    for (let e = 0; e < weights.length; e++) {
      weights[e] =
        (edgeMeters[e]! / 1000) * params.minutesPerKm[edgeGroup[e]!]! +
        edgeSignals[e]! * params.signalMinutes +
        edgeJunction[e]! * params.junctionMinutes;
    }
    return weights;
  }

  private cellKey(i: number, j: number): string {
    return `${i}:${j}`;
  }
}

/** Binary min-heap of (node, key) with lazy deletion, on typed arrays. */
class NodeHeap {
  private nodes: Int32Array;
  private keys: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.nodes = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  push(node: number, key: number): void {
    if (this.size === this.nodes.length) {
      const nodes = new Int32Array(this.size * 2);
      nodes.set(this.nodes);
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.nodes = nodes;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.nodes[i] = this.nodes[p]!;
      this.keys[i] = this.keys[p]!;
      i = p;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
  }

  popNode(): number {
    const top = this.nodes[0]!;
    const lastNode = this.nodes[--this.size]!;
    const lastKey = this.keys[this.size]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1]! < this.keys[c]!) c++;
      if (this.keys[c]! >= lastKey) break;
      this.nodes[i] = this.nodes[c]!;
      this.keys[i] = this.keys[c]!;
      i = c;
    }
    this.nodes[i] = lastNode;
    this.keys[i] = lastKey;
    return top;
  }
}
