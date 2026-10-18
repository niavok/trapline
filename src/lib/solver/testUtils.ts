import { MODES, type Mode, type SolverInput, type SolverNode, type TimeInterval, type TravelMatrix } from "./types";

export type TimeFn = (from: string, to: string) => number | null;

/** Builds a matrix from a function on node ids (diagonal forced to 0). */
export function matrixFrom(nodes: readonly SolverNode[], fn: TimeFn): TravelMatrix {
  return nodes.map((a) => nodes.map((b) => (a.id === b.id ? 0 : fn(a.id, b.id))));
}

/** Symmetric lookup table: { "A-B": 5 } gives A->B and B->A = 5. */
export function table(entries: Record<string, number | null>, fallback: number | null): TimeFn {
  return (from, to) => {
    const direct = entries[`${from}-${to}`];
    if (direct !== undefined) return direct;
    const reverse = entries[`${to}-${from}`];
    if (reverse !== undefined) return reverse;
    return fallback;
  };
}

export function makeInput(
  nodes: SolverNode[],
  brands: string[],
  times: Partial<Record<Mode, TimeFn>>,
  overrides: Partial<SolverInput> = {},
): SolverInput {
  const matrices: SolverInput["matrices"] = {};
  for (const [mode, fn] of Object.entries(times) as [Mode, TimeFn][]) {
    matrices[mode] = matrixFrom(nodes, fn);
  }
  return {
    nodes,
    homeIndex: nodes.findIndex((n) => n.kind === "home"),
    brands,
    matrices,
    coefficients: { walk: 0.8, transit: 1.0, drive: 1.2 },
    dwellMinutes: 10,
    parkingPenaltyMinutes: 12,
    k: 5,
    ...overrides,
  };
}

export function route(input: SolverInput, legs: { from: number; to: number; mode: Mode }[]): string[] {
  return legs.map((l) => `${input.nodes[l.from]!.id}>${input.nodes[l.to]!.id}:${l.mode}`);
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small random instance with roughly metric matrices and tight opening hours. */
export function randomInstance(seed: number): SolverInput {
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const brandCount = int(1, 3);
  const nodes: SolverNode[] = [{ id: "H", kind: "home" }];
  if (rand() < 0.7) nodes.push({ id: "P", kind: "parking", parkingPenaltyMinutes: int(0, 5) });
  for (let b = 0; b < brandCount; b++) {
    const count = int(1, 3);
    for (let s = 0; s < count; s++) {
      const node: SolverNode = { id: `S${b}${s}`, kind: "shop", brandIndex: b };
      // Tight, sometimes split, opening hours so that clock time really matters.
      if (rand() < 0.7) {
        const start = int(0, 90);
        const first: TimeInterval = [start, start + int(15, 80)];
        node.openIntervals =
          rand() < 0.4 ? [first, [first[1] + int(10, 40), first[1] + int(60, 150)]] : [first];
      }
      nodes.push(node);
    }
  }
  const coords = nodes.map(() => [rand() * 8, rand() * 8] as const);
  const dist = (i: number, j: number) => Math.hypot(coords[i]![0] - coords[j]![0], coords[i]![1] - coords[j]![1]);
  const speed: Record<Mode, [number, number]> = { walk: [12, 1], transit: [3, 8], drive: [2, 4] };
  const allowed = MODES.filter(() => rand() < 0.8);
  const modes = allowed.length > 0 ? allowed : (["walk"] as Mode[]);
  const matrices: SolverInput["matrices"] = {};
  for (const mode of modes) {
    const [perKm, fixed] = speed[mode];
    matrices[mode] = nodes.map((_, i) =>
      nodes.map((_, j) => (i === j ? 0 : rand() < 0.1 ? null : Math.round(dist(i, j) * perKm + fixed))),
    );
  }
  return {
    nodes,
    homeIndex: 0,
    brands: Array.from({ length: brandCount }, (_, i) => `B${i}`),
    matrices,
    coefficients: { walk: 0.5 + rand(), transit: 0.5 + rand(), drive: 0.5 + rand() },
    dwellMinutes: int(0, 15),
    parkingPenaltyMinutes: int(1, 15),
    waitCostPerMinute: rand() < 0.5 ? 0 : 0.5 + rand(),
    k: 4,
  };
}
