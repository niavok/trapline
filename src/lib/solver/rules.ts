import type { Leg, Mode, SolverInput, TimeInterval } from "./types";

/** Sentinel car position when driving is not allowed at all. */
export const NO_CAR = -1;

/**
 * Earliest time we can start shopping when arriving at `arrival`, such that the
 * whole dwell fits inside one opening interval. Arriving before opening means
 * waiting; returns null if no interval can accommodate the visit.
 */
export function earliestStart(
  intervals: readonly TimeInterval[] | undefined,
  arrival: number,
  dwell: number,
): number | null {
  if (intervals === undefined) return arrival;
  let best: number | null = null;
  for (const [start, end] of intervals) {
    const begin = Math.max(arrival, start);
    if (begin + dwell <= end && (best === null || begin < best)) best = begin;
  }
  return best;
}

export function parkingPenaltyAt(input: SolverInput, to: number): number {
  if (to === input.homeIndex) return 0;
  return input.nodes[to]?.parkingPenaltyMinutes ?? input.parkingPenaltyMinutes;
}

export interface MoveContext {
  time: number;
  car: number;
  mask: number;
}

export interface MoveOutcome {
  leg: Leg;
  car: number;
  mask: number;
}

/**
 * Applies one leg (from -> to by mode) to a context, given the raw travel time
 * and its weighted travel cost. Returns null if the leg is not allowed or the
 * target shop cannot be visited in time. Movement *pruning* (which targets are
 * worth exploring) lives in the solver; this function only enforces validity.
 */
export function applyMove(
  input: SolverInput,
  ctx: MoveContext,
  from: number,
  to: number,
  mode: Mode,
  travelMinutes: number,
  travelCost: number,
): MoveOutcome | null {
  if (from === to) return null;
  if (mode === "drive" && ctx.car !== from) return null;
  const node = input.nodes[to];
  if (!node) return null;

  const parkingMinutes = mode === "drive" ? parkingPenaltyAt(input, to) : 0;
  const arrival = ctx.time + travelMinutes + parkingMinutes;

  let mask = ctx.mask;
  let waitMinutes = 0;
  let dwellMinutes = 0;
  let visitedBrand: number | undefined;
  if (node.kind === "shop" && node.brandIndex !== undefined) {
    const bit = 1 << node.brandIndex;
    if ((mask & bit) === 0) {
      const start = earliestStart(node.openIntervals, arrival, input.dwellMinutes);
      if (start === null) return null;
      waitMinutes = start - arrival;
      dwellMinutes = input.dwellMinutes;
      mask |= bit;
      visitedBrand = node.brandIndex;
    }
  }

  const readyAt = arrival + waitMinutes + dwellMinutes;
  return {
    car: mode === "drive" ? to : ctx.car,
    mask,
    leg: {
      from,
      to,
      mode,
      departAt: ctx.time,
      travelMinutes,
      parkingMinutes,
      waitMinutes,
      dwellMinutes,
      readyAt,
      cost: travelCost + parkingMinutes + waitMinutes * (input.waitCostPerMinute ?? 0) + dwellMinutes,
      visitedBrand,
    },
  };
}

export function fullMask(brandCount: number): number {
  return brandCount === 0 ? 0 : (1 << brandCount) - 1;
}
