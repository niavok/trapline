/**
 * Directed road graph in compressed sparse row form: the edges leaving node i
 * are edgeStart[i] .. edgeStart[i + 1] - 1.
 */
export interface RoadGraphData {
  nodeLat: Float64Array;
  nodeLng: Float64Array;
  edgeStart: Uint32Array;
  edgeTarget: Uint32Array;
  edgeMeters: Float32Array;
  /** Road group index (see ROAD_GROUPS). */
  edgeGroup: Uint8Array;
  /** Traffic lights met along the edge, including at its target node. */
  edgeSignals: Uint8Array;
  /** 1 when the target node is a junction (3+ distinct neighbours). */
  edgeJunction: Uint8Array;
}

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  id: number;
  refs: number[];
  tags?: Record<string, string>;
}

/** Two passes over the same extract: ways first, then nodes. */
export interface OsmSource {
  ways(): AsyncIterable<OsmWay>;
  nodes(): AsyncIterable<OsmNode>;
}
