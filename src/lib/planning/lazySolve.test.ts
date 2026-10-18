import { describe, expect, it } from "vitest";
import { MemoryTravelTimeCache } from "@/lib/cache/memory";
import type { LatLng } from "@/lib/geo/geo";
import { solve, type Mode, type SolveResult, type SolverInput, type TravelMatrix } from "@/lib/solver";
import { mulberry32, randomInstance } from "@/lib/solver/testUtils";
import { cachedSource } from "./cachedSource";
import { lazySolve, legKey, type LegRequest, type LegTimes, type TravelTimeSource } from "./lazySolve";

const costsOf = (result: SolveResult) => (result.status === "ok" ? result.tours.map((t) => t.cost) : []);

/** Replaces transit/drive matrices by optimistic estimates (<= real time). */
function withOptimisticEstimates(truth: SolverInput, seed: number): SolverInput {
  const rand = mulberry32(seed * 7919);
  const matrices: SolverInput["matrices"] = { ...truth.matrices };
  for (const mode of ["transit", "drive"] as const) {
    const real = truth.matrices[mode];
    if (!real) continue;
    matrices[mode] = real.map((row) => row.map((v) => (v === null ? 1 : v * (0.4 + 0.6 * rand()))));
  }
  return { ...truth, matrices };
}

/** Exactness needs a score that never grows when a time shrinks: free waiting. */
const instance = (seed: number): SolverInput => ({ ...randomInstance(seed), waitCostPerMinute: 0 });

/** A source that knows the truth and counts what it is asked. */
function oracle(truth: SolverInput) {
  const stats = { measured: 0, calls: 0 };
  const source: TravelTimeSource = {
    lookup: async () => new Map(),
    measure: async (legs) => {
      stats.calls++;
      stats.measured += legs.length;
      return new Map(legs.map((leg) => [legKey(leg), truth.matrices[leg.mode]![leg.from]![leg.to]!]));
    },
  };
  return { source, stats };
}

describe("lazySolve", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "gives the same top-k as full real matrices, measuring fewer legs (batch %i)",
    async (batch) => {
      let measured = 0;
      let possible = 0;
      for (let seed = batch * 100; seed < batch * 100 + 30; seed++) {
        const truth = instance(seed);
        const { source, stats } = oracle(truth);

        const lazy = await lazySolve(withOptimisticEstimates(truth, seed), source);

        expect(lazy.converged).toBe(true);
        expect(costsOf(lazy.result).map((c) => c.toFixed(6))).toEqual(costsOf(solve(truth)).map((c) => c.toFixed(6)));
        expect(lazy.measuredLegs).toBe(stats.measured);
        measured += stats.measured;
        const n = truth.nodes.length;
        possible += (["transit", "drive"] as const).filter((m) => truth.matrices[m]).length * n * (n - 1);
      }
      expect(measured).toBeLessThan(possible * 0.6);
    },
  );

  it("measures only a small share of a realistic matrix with calibrated estimates", async () => {
    // 5 brands x 6 shops spread over 30 km. Real times are a distance model
    // plus 0-50% noise; estimates are the calibrated model without the noise.
    const rand = mulberry32(4242);
    const points = Array.from({ length: 31 }, () => [rand() * 30, rand() * 30] as const);
    const d = (i: number, j: number) => Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]);
    const build = (perKm: number, fixed: number, noise: number): TravelMatrix =>
      points.map((_, i) => points.map((_, j) => (i === j ? 0 : (d(i, j) * perKm + fixed) * (1 + noise * rand()))));
    const truth: SolverInput = {
      nodes: points.map((_, i) =>
        i === 0 ? { id: "H", kind: "home" } : { id: `S${i}`, kind: "shop", brandIndex: (i - 1) % 5 },
      ),
      homeIndex: 0,
      brands: ["a", "b", "c", "d", "e"],
      matrices: { walk: build(15, 0, 0), transit: build(2.6, 10, 0.5), drive: build(1.6, 6, 0.5) },
      coefficients: { walk: 0.8, transit: 1, drive: 1.2 },
      dwellMinutes: 10,
      parkingPenaltyMinutes: 12,
      k: 5,
    };
    const estimates: SolverInput = {
      ...truth,
      matrices: { walk: truth.matrices.walk, transit: build(2.6, 10, 0), drive: build(1.6, 6, 0) },
    };
    const { source, stats } = oracle(truth);

    const lazy = await lazySolve(estimates, source);
    expect(lazy.converged).toBe(true);
    expect(costsOf(lazy.result)).toEqual(costsOf(solve(truth)));
    expect(stats.measured).toBeLessThan(0.1 * 2 * 31 * 30);
  });

  it("stops after maxRounds and reports it did not converge", async () => {
    const truth: SolverInput = {
      nodes: [{ id: "H", kind: "home" }, { id: "A", kind: "shop", brandIndex: 0 }],
      homeIndex: 0,
      brands: ["a"],
      matrices: { transit: [[0, 30], [30, 0]] },
      coefficients: { walk: 0.8, transit: 1, drive: 1.2 },
      dwellMinutes: 10,
      parkingPenaltyMinutes: 12,
      k: 1,
    };
    const estimates = { ...truth, matrices: { transit: [[0, 5], [5, 0]] } };

    const stopped = await lazySolve(estimates, oracle(truth).source, { maxRounds: 0 });
    expect(stopped).toMatchObject({ converged: false, measuredLegs: 0 });
    expect(costsOf(stopped.result)).toEqual([20]);

    const done = await lazySolve(estimates, oracle(truth).source);
    expect(done).toMatchObject({ converged: true, measuredLegs: 2, rounds: 2 });
    expect(costsOf(done.result)).toEqual([70]);
  });
});

describe("cachedSource", () => {
  // Home in Paris 11e, two shops 50 m apart near Chatelet, one at La Defense.
  const points: LatLng[] = [
    { lat: 48.8566, lng: 2.3802 },
    { lat: 48.8606, lng: 2.3469 },
    { lat: 48.8608, lng: 2.3473 },
    { lat: 48.8919, lng: 2.2381 },
  ];
  const fakeFetcher = () => {
    const asked: LegRequest[] = [];
    const fetcher = async (legs: readonly LegRequest[]): Promise<LegTimes> => {
      asked.push(...legs);
      return new Map(legs.map((leg) => [legKey(leg), 10 + leg.from + leg.to]));
    };
    return { asked, fetcher };
  };

  it("shares one measurement between legs of the same zone pair", async () => {
    const { asked, fetcher } = fakeFetcher();
    const source = cachedSource(points, "saturday", new MemoryTravelTimeCache(), fetcher);

    const times = await source.measure([
      { mode: "transit", from: 0, to: 1 },
      { mode: "transit", from: 0, to: 2 },
      { mode: "transit", from: 0, to: 3 },
    ]);

    expect(asked).toHaveLength(2);
    expect(times.get("transit:0>2")).toBe(times.get("transit:0>1"));
  });

  it("serves later requests from the cache, per mode and time slot", async () => {
    const cache = new MemoryTravelTimeCache();
    const first = fakeFetcher();
    await cachedSource(points, "saturday", cache, first.fetcher).measure([{ mode: "drive", from: 0, to: 3 }]);

    const second = cachedSource(points, "saturday", cache, fakeFetcher().fetcher);
    expect(await second.lookup([{ mode: "drive", from: 0, to: 3 }])).toEqual(new Map([["drive:0>3", 13]]));
    expect(await second.lookup([{ mode: "transit", from: 0, to: 3 }])).toEqual(new Map());
    const otherSlot = cachedSource(points, "weekday-peak", cache, fakeFetcher().fetcher);
    expect(await otherSlot.lookup([{ mode: "drive", from: 0, to: 3 }])).toEqual(new Map());
  });

  it("makes a second identical lazy solve free", async () => {
    const truth = instance(11);
    const n = truth.nodes.length;
    // Points far apart so that every node has its own zone.
    const spread = Array.from({ length: n }, (_, i) => ({ lat: 48.6 + 0.05 * i, lng: 2.2 + 0.03 * i }));
    const cache = new MemoryTravelTimeCache();
    let fetched = 0;
    const fetcher = async (legs: readonly LegRequest[]) => {
      fetched += legs.length;
      return new Map(legs.map((leg) => [legKey(leg), truth.matrices[leg.mode as Mode]![leg.from]![leg.to]!]));
    };
    const estimates = withOptimisticEstimates(truth, 11);

    const first = await lazySolve(estimates, cachedSource(spread, "sunday", cache, fetcher));
    const fetchedFirst = fetched;
    const second = await lazySolve(estimates, cachedSource(spread, "sunday", cache, fetcher));

    expect(fetchedFirst).toBeGreaterThan(0);
    expect(fetched).toBe(fetchedFirst);
    expect(second.measuredLegs).toBe(0);
    expect(costsOf(second.result)).toEqual(costsOf(first.result));
  });
});
