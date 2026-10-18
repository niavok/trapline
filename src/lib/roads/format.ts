import type { RoadGraphData } from "./types";

const MAGIC = 0x47525254; // "TRRG"
const VERSION = 1;

/**
 * Binary layout (little endian): magic, version, nodeCount, edgeCount (u32),
 * then lat, lng (f32 x nodes), edgeStart (u32 x nodes + 1), edgeTarget (u32),
 * edgeMeters (f32), edgeGroup, edgeSignals, edgeJunction (u8 x edges), each
 * section padded to 4 bytes. Float32 coordinates are precise to ~0.5 m.
 */
export function serializeRoadGraph(g: RoadGraphData): Uint8Array {
  const n = g.nodeLat.length;
  const m = g.edgeTarget.length;
  const pad = (bytes: number) => (bytes + 3) & ~3;
  const sections: ArrayBufferView[] = [
    new Uint32Array([MAGIC, VERSION, n, m]),
    Float32Array.from(g.nodeLat),
    Float32Array.from(g.nodeLng),
    g.edgeStart,
    g.edgeTarget,
    g.edgeMeters,
    g.edgeGroup,
    g.edgeSignals,
    g.edgeJunction,
  ];
  const total = sections.reduce((sum, s) => sum + pad(s.byteLength), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of sections) {
    out.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), offset);
    offset += pad(s.byteLength);
  }
  return out;
}

export function deserializeRoadGraph(bytes: Uint8Array): RoadGraphData {
  // Copy into a fresh, aligned buffer so typed array views are valid.
  const buffer = bytes.slice().buffer;
  const header = new Uint32Array(buffer, 0, 4);
  if (header[0] !== MAGIC) throw new Error("Not a road graph file");
  if (header[1] !== VERSION) throw new Error(`Unsupported road graph version ${header[1]}`);
  const n = header[2]!;
  const m = header[3]!;
  let offset = 16;
  const take = <T>(make: (offset: number) => T, bytes: number): T => {
    const view = make(offset);
    offset += (bytes + 3) & ~3;
    return view;
  };
  const lat = take((o) => new Float32Array(buffer, o, n), n * 4);
  const lng = take((o) => new Float32Array(buffer, o, n), n * 4);
  return {
    nodeLat: Float64Array.from(lat),
    nodeLng: Float64Array.from(lng),
    edgeStart: take((o) => new Uint32Array(buffer, o, n + 1), (n + 1) * 4),
    edgeTarget: take((o) => new Uint32Array(buffer, o, m), m * 4),
    edgeMeters: take((o) => new Float32Array(buffer, o, m), m * 4),
    edgeGroup: take((o) => new Uint8Array(buffer, o, m), m),
    edgeSignals: take((o) => new Uint8Array(buffer, o, m), m),
    edgeJunction: take((o) => new Uint8Array(buffer, o, m), m),
  };
}
