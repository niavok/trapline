import { NO_CAR, applyMove, fullMask } from "./rules";
import { summarizeTour } from "./summary";
import type { Leg, Mode, SolverInput, Tour } from "./types";

export interface ItineraryStep {
  to: number;
  mode: Mode;
}

/** Travel time and weighted cost of one leg, as known by the caller. */
export interface LegEstimate {
  travelMinutes: number;
  travelCost: number;
}

/**
 * Supplies the travel estimate of a leg given its actual departure time.
 * Returning null means "no route". The default uses the solver matrices.
 */
export type LegEstimator = (
  from: number,
  to: number,
  mode: Mode,
  departAt: number,
  legIndex: number,
) => LegEstimate | null;

export type SimulationResult =
  | { ok: true; tour: Tour }
  | { ok: false; failedLeg: number; reason: "no-route" | "invalid-move" | "incomplete" };

export function matrixEstimator(input: SolverInput): LegEstimator {
  return (from, to, mode) => {
    const travel = input.matrices[mode]?.[from]?.[to];
    if (travel === null || travel === undefined) return null;
    return { travelMinutes: travel, travelCost: travel * input.coefficients[mode] };
  };
}

/**
 * Replays a fixed itinerary from home, re-checking car position and opening
 * hours. Used by the refinement pass, where legs get more precise times and
 * costs than the matrices provided.
 */
export function simulateItinerary(
  input: SolverInput,
  steps: readonly ItineraryStep[],
  estimate: LegEstimator = matrixEstimator(input),
): SimulationResult {
  const hasCar = input.matrices.drive !== undefined;
  let ctx = { time: 0, car: hasCar ? input.homeIndex : NO_CAR, mask: 0 };
  let pos = input.homeIndex;
  const legs: Leg[] = [];

  for (const [i, step] of steps.entries()) {
    const est = estimate(pos, step.to, step.mode, ctx.time, i);
    if (!est) return { ok: false, failedLeg: i, reason: "no-route" };
    const outcome = applyMove(input, ctx, pos, step.to, step.mode, est.travelMinutes, est.travelCost);
    if (!outcome) return { ok: false, failedLeg: i, reason: "invalid-move" };
    legs.push(outcome.leg);
    ctx = { time: outcome.leg.readyAt, car: outcome.car, mask: outcome.mask };
    pos = step.to;
  }

  const complete =
    pos === input.homeIndex &&
    ctx.mask === fullMask(input.brands.length) &&
    (ctx.car === input.homeIndex || ctx.car === NO_CAR);
  if (!complete) return { ok: false, failedLeg: steps.length, reason: "incomplete" };
  return { ok: true, tour: summarizeTour(legs) };
}

export function itineraryOf(tour: Tour): ItineraryStep[] {
  return tour.legs.map((leg) => ({ to: leg.to, mode: leg.mode }));
}
