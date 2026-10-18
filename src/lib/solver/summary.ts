import type { Leg, Mode, Tour } from "./types";

export function summarizeTour(legs: Leg[]): Tour {
  const travelMinutesByMode: Record<Mode, number> = { walk: 0, transit: 0, drive: 0 };
  let cost = 0;
  let waitMinutes = 0;
  for (const leg of legs) {
    travelMinutesByMode[leg.mode] += leg.travelMinutes;
    cost += leg.cost;
    waitMinutes += leg.waitMinutes;
  }
  return {
    cost,
    durationMinutes: legs.length > 0 ? legs[legs.length - 1]!.readyAt : 0,
    travelMinutesByMode,
    waitMinutes,
    legs,
  };
}
