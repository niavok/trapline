import type { Mode, TravelMatrix } from "@/lib/solver";
import { haversineKm, type LatLng } from "./geo";

/** Travel time model: fixed overhead + straight-line distance x detour / speed. */
export interface CrowFlyModel {
  fixedMinutes: number;
  detourFactor: number;
  kmh: number;
}

export type CrowFlyModels = Record<Mode, CrowFlyModel>;

/**
 * Walking is never measured through an API: this is the value used as is.
 * The other two are deliberately optimistic (lower bounds in practice), which
 * is what makes the lazy measurement loop safe: a tour rejected with optimistic
 * times would be rejected with real ones too.
 */
export const OPTIMISTIC_MODELS: CrowFlyModels = {
  walk: { fixedMinutes: 0, detourFactor: 1.3, kmh: 4.8 },
  // Access to a station + minimal wait, then RER-like speed as the crow flies.
  transit: { fixedMinutes: 5, detourFactor: 1, kmh: 60 },
  // Getting out / in the car park is already covered by the parking penalty.
  drive: { fixedMinutes: 2, detourFactor: 1, kmh: 90 },
};

export function crowFlyMinutes(model: CrowFlyModel, from: LatLng, to: LatLng): number {
  const km = haversineKm(from, to) * model.detourFactor;
  return model.fixedMinutes + (km / model.kmh) * 60;
}

export function crowFlyMatrices(
  points: readonly LatLng[],
  modes: readonly Mode[],
  models: CrowFlyModels = OPTIMISTIC_MODELS,
): Partial<Record<Mode, TravelMatrix>> {
  const matrices: Partial<Record<Mode, TravelMatrix>> = {};
  for (const mode of modes) {
    const model = models[mode];
    matrices[mode] = points.map((from, i) =>
      points.map((to, j) => (i === j ? 0 : crowFlyMinutes(model, from, to))),
    );
  }
  return matrices;
}
