import type { LatLng } from "@/lib/geo/geo";
import { ROAD_GROUPS, type DriveParams } from "./classes";
import type { RoadGraph } from "./graph";

export interface ReferenceTrip {
  label?: string;
  from: LatLng;
  to: LatLng;
  /** Observed door-to-door driving minutes (without parking). */
  minutes: number;
}

export interface CalibrationOptions {
  iterations?: number;
  /**
   * Pull towards the prior parameters: with few trips, many parameters are
   * poorly constrained. Squared relative deviation is weighted by this.
   */
  priorWeight?: number;
  prior?: DriveParams;
}

export interface TripReport {
  label: string;
  actual: number;
  before: number | null;
  after: number | null;
}

export interface CalibrationResult {
  params: DriveParams;
  trips: TripReport[];
  meanAbsErrorBefore: number;
  meanAbsErrorAfter: number;
}

const toVector = (p: DriveParams) => [...p.minutesPerKm, p.signalMinutes, p.junctionMinutes, p.fixedMinutes];
const fromVector = (x: number[], accessKmh: number): DriveParams => ({
  minutesPerKm: x.slice(0, ROAD_GROUPS.length),
  signalMinutes: x[ROAD_GROUPS.length]!,
  junctionMinutes: x[ROAD_GROUPS.length + 1]!,
  fixedMinutes: x[ROAD_GROUPS.length + 2]!,
  accessKmh,
});
const LOWER = [...ROAD_GROUPS.map(() => 60 / 130), 0, 0, 0];
const UPPER = [...ROAD_GROUPS.map(() => 60 / 5), 3, 1, 15];

/**
 * Fits the linear drive time model to observed trips: route with the current
 * parameters, regress minutes on the path features (km per road group,
 * traffic lights, junctions, constant), re-route with the new parameters, and
 * repeat, since better speeds can change the chosen paths.
 */
export function calibrate(
  graph: RoadGraph,
  trips: readonly ReferenceTrip[],
  options: CalibrationOptions = {},
): CalibrationResult {
  const prior = options.prior ?? graph.driveParams;
  const priorWeight = options.priorWeight ?? 2;
  const iterations = options.iterations ?? 4;
  const x0 = toVector(prior);

  const predict = () => trips.map((t) => graph.driveMatrix([t.from, t.to])[0]![1] ?? null);
  graph.setParams(prior);
  const before = predict();

  let x = [...x0];
  for (let it = 0; it < iterations; it++) {
    graph.setParams(fromVector(x, prior.accessKmh));
    const rows: number[][] = [];
    const targets: number[] = [];
    for (const trip of trips) {
      const a = graph.nearestNode(trip.from);
      const b = graph.nearestNode(trip.to);
      if (!a || !b) continue;
      const f = graph.pathFeatures(a.node, b.node);
      if (!f) continue;
      rows.push([...f.kmByGroup, f.signals, f.junctions, 1]);
      targets.push(trip.minutes - graph.accessMinutes(a) - graph.accessMinutes(b));
    }
    x = boundedRidge(rows, targets, x0, priorWeight);
  }

  // The graph is left with the calibrated parameters.
  const params = fromVector(x, prior.accessKmh);
  graph.setParams(params);
  const after = predict();

  const report = trips.map((t, i) => ({
    label: t.label ?? `trip ${i + 1}`,
    actual: t.minutes,
    before: before[i]!,
    after: after[i]!,
  }));
  return {
    params,
    trips: report,
    meanAbsErrorBefore: meanAbsError(report.map((r) => [r.before, r.actual])),
    meanAbsErrorAfter: meanAbsError(report.map((r) => [r.after, r.actual])),
  };
}

function meanAbsError(pairs: (number | null)[][]): number {
  const errors = pairs.filter(([p]) => p !== null).map(([p, a]) => Math.abs(p! - a!));
  return errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : NaN;
}

/**
 * min sum (row . x - target)^2 + w * sum ((x_i - x0_i) / x0_i)^2 within
 * [LOWER, UPPER], by cyclic coordinate descent (exact per coordinate).
 */
function boundedRidge(rows: number[][], targets: number[], x0: number[], w: number): number[] {
  const dim = x0.length;
  const x = [...x0];
  const scale = x0.map((v) => Math.max(Math.abs(v), 0.05));
  const residual = rows.map((row, r) => row.reduce((s, v, i) => s + v * x[i]!, 0) - targets[r]!);
  for (let sweep = 0; sweep < 500; sweep++) {
    let moved = 0;
    for (let i = 0; i < dim; i++) {
      let aa = w / scale[i]! ** 2;
      let ar = (w * (x[i]! - x0[i]!)) / scale[i]! ** 2;
      rows.forEach((row, r) => {
        aa += row[i]! ** 2;
        ar += row[i]! * residual[r]!;
      });
      const next = Math.min(UPPER[i]!, Math.max(LOWER[i]!, x[i]! - ar / aa));
      const delta = next - x[i]!;
      if (delta === 0) continue;
      x[i] = next;
      rows.forEach((row, r) => (residual[r]! += row[i]! * delta));
      moved = Math.max(moved, Math.abs(delta));
    }
    if (moved < 1e-7) break;
  }
  return x;
}
