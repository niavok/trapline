import type { Mode, SolverInput, SolverNode, TravelMatrix } from "./types";

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
