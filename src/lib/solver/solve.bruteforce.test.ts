import { describe, expect, it } from "vitest";
import { solve } from "./solve";
import { MODES, type Mode, type SolverInput, type SolverNode, type TimeInterval } from "./types";

// Cross-checks the label-setting search against an exhaustive branch-and-bound
// enumeration that re-implements the tour rules independently (only the
// "useful target" move restriction is shared, as it is part of the model).

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(seed: number): SolverInput {
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
    k: 4,
  };
}

/** Walk/transit legs strictly no better than the other mode are not tours we list. */
function isDominatedMode(input: SolverInput, mode: Mode, from: number, to: number): boolean {
  if (mode === "drive") return false;
  const other: Mode = mode === "walk" ? "transit" : "walk";
  const mine = input.matrices[mode]![from]![to]!;
  const theirs = input.matrices[other]?.[from]?.[to];
  if (theirs === null || theirs === undefined) return false;
  const faster = theirs <= mine;
  const cheaper = theirs * input.coefficients[other] <= mine * input.coefficients[mode];
  if (!faster || !cheaper) return false;
  // Exact ties: keep walking, drop transit.
  const tie = theirs === mine && theirs * input.coefficients[other] === mine * input.coefficients[mode];
  return !tie || mode === "transit";
}

/** All tour costs <= bound, by exhaustive DFS. */
function bruteForceCosts(input: SolverInput, bound: number): number[] {
  const n = input.nodes.length;
  const home = input.homeIndex;
  const goal = (1 << input.brands.length) - 1;
  const hasCar = input.matrices.drive !== undefined;
  const costs: number[] = [];

  const visitStart = (intervals: readonly TimeInterval[] | undefined, t: number): number | null => {
    if (!intervals) return t;
    const fits = intervals
      .map(([s, e]) => Math.max(s, t))
      .filter((start, i) => start + input.dwellMinutes <= intervals[i]![1]);
    return fits.length > 0 ? Math.min(...fits) : null;
  };

  const dfs = (pos: number, car: number | null, mask: number, time: number, cost: number) => {
    if (cost > bound + 1e-9) return;
    if (pos === home && mask === goal && (car === home || car === null)) {
      costs.push(cost);
      return;
    }
    for (const mode of MODES) {
      const matrix = input.matrices[mode];
      if (!matrix) continue;
      if (mode === "drive" && car !== pos) continue;
      for (let to = 0; to < n; to++) {
        if (to === pos) continue;
        const node = input.nodes[to]!;
        const undone = node.kind === "shop" && (mask & (1 << node.brandIndex!)) === 0;
        const useful =
          mode === "drive" || undone || to === car || (car === null && mask === goal && to === home);
        if (!useful) continue;
        const travel = matrix[pos]![to];
        if (travel === null || travel === undefined) continue;
        if (isDominatedMode(input, mode, pos, to)) continue;
        let t = time + travel;
        let c = cost + travel * input.coefficients[mode];
        if (mode === "drive" && to !== home) {
          const p = node.parkingPenaltyMinutes ?? input.parkingPenaltyMinutes;
          t += p;
          c += p;
        }
        let m = mask;
        if (undone) {
          const start = visitStart(node.openIntervals, t);
          if (start === null) continue;
          c += start - t + input.dwellMinutes;
          t = start + input.dwellMinutes;
          m |= 1 << node.brandIndex!;
        }
        dfs(to, mode === "drive" ? to : car, m, t, c);
      }
    }
  };

  dfs(home, hasCar ? home : null, 0, 0, 0);
  return costs.sort((a, b) => a - b);
}

describe("solve vs brute force", () => {
  it.each(Array.from({ length: 300 }, (_, i) => i + 1))("matches on random instance #%i", (seed) => {
    const input = randomInstance(seed);
    const result = solve(input);
    if (result.status === "no-candidates") throw new Error("generator always creates candidates");

    const solverCosts = result.status === "ok" ? result.tours.map((t) => t.cost) : [];
    // If the solver found k tours, nothing cheaper than its k-th may exist.
    // Otherwise it claims there are no more tours: check up to a generous cap.
    const bound = solverCosts.length === input.k ? solverCosts.at(-1)! : Math.max(250, ...solverCosts);
    const brute = bruteForceCosts(input, bound).slice(0, input.k);

    expect(solverCosts.length, `solver: ${solverCosts.join(",")}`).toBe(brute.length);
    solverCosts.forEach((c, i) => expect(c).toBeCloseTo(brute[i]!, 6));
  });
});

describe("solve performance", () => {
  it("handles 5 brands x 8 candidates + 2 parkings with 3 modes quickly", () => {
    const rand = mulberry32(42);
    const nodes: SolverNode[] = [
      { id: "H", kind: "home" },
      { id: "P1", kind: "parking", parkingPenaltyMinutes: 3 },
      { id: "P2", kind: "parking", parkingPenaltyMinutes: 3 },
    ];
    for (let b = 0; b < 5; b++) {
      for (let s = 0; s < 8; s++) {
        nodes.push({ id: `S${b}${s}`, kind: "shop", brandIndex: b, openIntervals: [[60 * rand(), 600]] });
      }
    }
    const coords = nodes.map(() => [rand() * 30, rand() * 30] as const);
    const d = (i: number, j: number) => Math.hypot(coords[i]![0] - coords[j]![0], coords[i]![1] - coords[j]![1]);
    const build = (perKm: number, fixed: number) =>
      nodes.map((_, i) => nodes.map((_, j) => (i === j ? 0 : d(i, j) * perKm + fixed)));
    const input: SolverInput = {
      nodes,
      homeIndex: 0,
      brands: ["a", "b", "c", "d", "e"],
      matrices: { walk: build(12, 1), transit: build(2.5, 10), drive: build(1.8, 5) },
      coefficients: { walk: 0.8, transit: 1, drive: 1.2 },
      dwellMinutes: 10,
      parkingPenaltyMinutes: 12,
      k: 10,
    };

    const started = performance.now();
    const result = solve(input);
    const elapsed = performance.now() - started;

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.tours).toHaveLength(10);
      expect(result.truncated).toBe(false);
    }
    expect(elapsed).toBeLessThan(5000);
  });
});
