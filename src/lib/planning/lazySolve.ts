import { MODES, solve, type Mode, type SolveResult, type SolverInput, type Tour, type TravelMatrix } from "@/lib/solver";

export interface LegRequest {
  mode: Mode;
  from: number;
  to: number;
}

export const legKey = (leg: LegRequest): string => `${leg.mode}:${leg.from}>${leg.to}`;

/** Raw minutes per leg key; null means "no route". Missing keys mean "unknown". */
export type LegTimes = Map<string, number | null>;

export interface TravelTimeSource {
  /** Values known for free (cache), no paid call. */
  lookup(legs: readonly LegRequest[]): Promise<LegTimes>;
  /** Real measurement (API); implementations also feed the cache. */
  measure(legs: readonly LegRequest[]): Promise<LegTimes>;
}

export interface LazySolveOptions {
  /** Modes whose estimates get replaced by measurements (walking stays estimated). */
  measuredModes?: readonly Mode[];
  maxRounds?: number;
  /**
   * Each round measures the unknown legs of the best k x lookahead tours, not
   * only the k returned: more legs per round, far fewer rounds.
   */
  lookahead?: number;
}

export interface LazySolveResult {
  result: SolveResult;
  /** Solver runs that triggered measurements, plus the final one. */
  rounds: number;
  /** Legs sent to `measure` (what costs money). */
  measuredLegs: number;
  /** Legs found in the cache up front. */
  cachedLegs: number;
  /** True when every measured-mode leg of the returned tours is a real value. */
  converged: boolean;
}

/**
 * Solves on estimated matrices, then replaces the estimates of the legs used
 * by the returned tours with real values, and starts again until those tours
 * only use real values. With optimistic estimates (never above the real time)
 * the result is the same as solving with full real matrices, while measuring
 * a small fraction of them.
 */
export async function lazySolve(
  input: SolverInput,
  source: TravelTimeSource,
  options: LazySolveOptions = {},
): Promise<LazySolveResult> {
  const measuredModes = (options.measuredModes ?? ["transit", "drive"]).filter(
    (mode) => input.matrices[mode] !== undefined,
  );
  const maxRounds = options.maxRounds ?? 30;
  const k = Math.max(1, Math.floor(input.k));
  const wide = Math.max(k, Math.ceil(k * (options.lookahead ?? 2)));
  const matrices = cloneMatrices(input.matrices);
  const known = new Set<string>();

  const apply = (times: LegTimes, legs: readonly LegRequest[], markAll: boolean) => {
    for (const leg of legs) {
      const key = legKey(leg);
      if (times.has(key)) {
        matrices[leg.mode]![leg.from]![leg.to] = times.get(key)!;
        known.add(key);
      } else if (markAll) {
        // The source could not tell: keep the estimate, do not ask again.
        known.add(key);
      }
    }
  };

  const everyLeg: LegRequest[] = [];
  const n = input.nodes.length;
  for (const mode of measuredModes) {
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) if (from !== to) everyLeg.push({ mode, from, to });
    }
  }
  const cached = everyLeg.length > 0 ? await source.lookup(everyLeg) : new Map();
  apply(cached, everyLeg, false);

  let measuredLegs = 0;
  for (let round = 1; ; round++) {
    const wideResult = solve({ ...input, matrices, k: wide });
    const result = topK(wideResult, k);
    const settled = result.status !== "ok" || unknownLegs(result.tours, measuredModes, known).length === 0;
    if (settled || round > maxRounds) {
      return { result, rounds: round, measuredLegs, cachedLegs: known.size - measuredLegs, converged: settled };
    }
    const pending = unknownLegs(wideResult.status === "ok" ? wideResult.tours : [], measuredModes, known);
    const times = await source.measure(pending);
    measuredLegs += pending.length;
    apply(times, pending, true);
  }
}

function topK(result: SolveResult, k: number): SolveResult {
  return result.status === "ok" ? { ...result, tours: result.tours.slice(0, k) } : result;
}

function unknownLegs(tours: readonly Tour[], modes: readonly Mode[], known: Set<string>): LegRequest[] {
  const pending = new Map<string, LegRequest>();
  for (const tour of tours) {
    for (const leg of tour.legs) {
      if (!modes.includes(leg.mode)) continue;
      const request = { mode: leg.mode, from: leg.from, to: leg.to };
      const key = legKey(request);
      if (!known.has(key)) pending.set(key, request);
    }
  }
  return [...pending.values()];
}

function cloneMatrices(source: SolverInput["matrices"]): Partial<Record<Mode, (number | null)[][]>> {
  const copy: Partial<Record<Mode, (number | null)[][]>> = {};
  for (const mode of MODES) {
    const matrix: TravelMatrix | undefined = source[mode];
    if (matrix) copy[mode] = matrix.map((row) => [...row]);
  }
  return copy;
}
