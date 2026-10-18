import { MinHeap } from "./heap";
import { NO_CAR, earliestStart, fullMask, parkingPenaltyAt } from "./rules";
import { simulateItinerary, type ItineraryStep } from "./simulate";
import { MODES, type Mode, type SolveResult, type SolverInput, type Tour } from "./types";

const EPSILON = 1e-9;
const MAX_BRANDS = 16;
const DEFAULT_MAX_EXPANDED = 2_000_000;

interface Label {
  /** Generalized cost so far. */
  g: number;
  /** g + admissible estimate of the remaining cost. */
  f: number;
  time: number;
  pos: number;
  car: number;
  mask: number;
  /** Encodes the set of shops visited so far (see `shopSignatures`). */
  sig: number;
  parent: Label | null;
  /** Mode of the leg that led here (null for the start label). */
  mode: Mode | null;
}

interface Settled {
  g: number;
  time: number;
  sig: number;
}

/**
 * Finds the k cheapest tours (generalized cost) that start and end at home,
 * satisfy every brand once, and bring the car back home.
 *
 * Search: label-setting A* over the state (position, car position, visited
 * brands), with a consistent lower bound (see `buildHeuristic`). Each label
 * also carries the real clock time, which drives opening-hour checks. Because
 * waiting is allowed and costs c per minute, a label A dominates B at the same
 * state when A.time <= B.time and A.g + c * extraWait <= B.g, where
 * extraWait = max(0, min(B.time, W) - A.time) bounds how much more A may have
 * to wait than B when replaying B's continuation, W being the latest opening
 * time among the shops still to visit (no waiting can happen after W).
 *
 * Top-k stays exact by only discarding a label once k settled labels dominate
 * it. With `distinct: "shopSet"`, those k dominators must have k different
 * shop sets, or one of them must have the very same shop set: any completion
 * of the dropped label is then beaten for its own set, or its set cannot rank
 * in the top-k (all labels at a state share the brands still to do, so equal
 * completions keep shop sets distinct).
 */
export function solve(input: SolverInput): SolveResult {
  validate(input);

  const brandCount = input.brands.length;
  const missing = brandsWithoutCandidates(input);
  if (missing.length > 0) return { status: "no-candidates", brands: missing };
  const unreachable = brandsUnreachable(input);
  if (unreachable.length > 0) return { status: "unreachable", brands: unreachable };

  const n = input.nodes.length;
  const home = input.homeIndex;
  const goalMask = fullMask(brandCount);
  const modes = MODES.filter((m) => input.matrices[m] !== undefined);
  const hasCar = input.matrices.drive !== undefined;
  const maxExpanded = input.maxExpandedLabels ?? DEFAULT_MAX_EXPANDED;
  const k = Math.max(1, Math.floor(input.k));
  const bySet = (input.distinct ?? "shopSet") === "shopSet";
  const shopSig = shopSignatures(input);
  const dwell = input.dwellMinutes;
  const waitCost = input.waitCostPerMinute ?? 0;

  // Per-node lookups for the hot loop.
  const brandBit = input.nodes.map((node) =>
    node.kind === "shop" && node.brandIndex !== undefined ? 1 << node.brandIndex : 0,
  );
  const parking = input.nodes.map((_, i) => parkingPenaltyAt(input, i));
  const intervals = input.nodes.map((node) => node.openIntervals);
  const dominatedMode = dominatedNonDriveModes(input);
  const heuristic = buildHeuristic(input);

  const carSlots = n + 1;
  const maskSlots = 1 << brandCount;
  const stateKey = (pos: number, car: number, mask: number) =>
    (pos * carSlots + (car + 1)) * maskSlots + mask;

  const settled = new Map<number, Settled[]>();
  const waitHorizon = latestOpeningByMask(input);
  const isDominated = (key: number, g: number, time: number, sig: number, mask: number): boolean => {
    const list = settled.get(key);
    if (!list) return false;
    const horizon = Math.min(time, waitHorizon[mask]!);
    const dominates = (s: Settled) =>
      s.time <= time + EPSILON && s.g + waitCost * Math.max(0, horizon - s.time) <= g + EPSILON;
    if (!bySet) {
      if (list.length < k) return false;
      let count = 0;
      for (const s of list) {
        if (dominates(s) && ++count >= k) return true;
      }
      return false;
    }
    const sets: number[] = [];
    for (const s of list) {
      if (dominates(s)) {
        if (s.sig === sig) return true;
        if (!sets.includes(s.sig)) {
          sets.push(s.sig);
          if (sets.length >= k) return true;
        }
      }
    }
    return false;
  };

  const heap = new MinHeap<Label>((a, b) => (a.f !== b.f ? a.f < b.f : a.time < b.time));
  const startCar = hasCar ? home : NO_CAR;
  heap.push({
    g: 0,
    f: heuristic(home, startCar, 0),
    time: 0,
    pos: home,
    car: startCar,
    mask: 0,
    sig: 0,
    parent: null,
    mode: null,
  });

  const goals: Label[] = [];
  const goalSets = new Set<number>();
  let expanded = 0;
  let truncated = false;

  while (heap.size > 0 && goals.length < k) {
    const label = heap.pop()!;
    const { pos, car, mask } = label;
    const key = stateKey(pos, car, mask);
    if (isDominated(key, label.g, label.time, label.sig, mask)) continue;
    const entry = { g: label.g, time: label.time, sig: label.sig };
    const list = settled.get(key);
    if (list) list.push(entry);
    else settled.set(key, [entry]);

    const allDone = mask === goalMask;
    if (pos === home && allDone && (car === home || car === NO_CAR)) {
      // At the goal only the score matters: keep the first (best) per set.
      if (!bySet || !goalSets.has(label.sig)) goals.push(label);
      goalSets.add(label.sig);
      continue;
    }

    if (++expanded > maxExpanded) {
      truncated = true;
      break;
    }

    for (const mode of modes) {
      const isDrive = mode === "drive";
      if (isDrive && car !== pos) continue;
      const row = input.matrices[mode]![pos]!;
      const coef = input.coefficients[mode];
      const skip = dominatedMode[mode]?.[pos];
      for (let to = 0; to < n; to++) {
        if (to === pos || skip?.[to]) continue;
        const bit = brandBit[to]!;
        const visits = bit !== 0 && (mask & bit) === 0;
        // Move pruning. Any mode may go to a shop of a brand not done yet, and
        // driving may go anywhere (any reachable node is a place to park).
        // Walking / transit may otherwise only go back to the car, or home at
        // the very end without a car: a leg to a place where nothing happens
        // never beats going straight on (if the matrices are roughly metric).
        if (!visits && !isDrive && to !== car && !(car === NO_CAR && allDone && to === home)) continue;
        const travel = row[to];
        if (travel === null || travel === undefined) continue;

        const park = isDrive ? parking[to]! : 0;
        let time = label.time + travel + park;
        let g = label.g + travel * coef + park;
        let nextMask = mask;
        let sig = label.sig;
        if (visits) {
          const start = earliestStart(intervals[to], time, dwell);
          if (start === null) continue;
          g += (start - time) * waitCost + dwell;
          time = start + dwell;
          nextMask |= bit;
          sig += shopSig[to]!;
        }
        const nextCar = isDrive ? to : car;
        if (isDominated(stateKey(to, nextCar, nextMask), g, time, sig, nextMask)) continue;
        heap.push({
          g,
          f: g + heuristic(to, nextCar, nextMask),
          time,
          pos: to,
          car: nextCar,
          mask: nextMask,
          sig,
          parent: label,
          mode,
        });
      }
    }
  }

  if (goals.length === 0) return { status: "infeasible", expandedLabels: expanded, truncated };
  return {
    status: "ok",
    tours: goals.map((goal) => replay(input, goal)),
    expandedLabels: expanded,
    truncated,
  };
}

/**
 * For each visited-brands mask, the latest time at which a shop still to visit
 * opens (start of any of its intervals). After that time nobody ever waits.
 */
function latestOpeningByMask(input: SolverInput): Float64Array {
  const brandCount = input.brands.length;
  const latestByBrand = new Array<number>(brandCount).fill(-Infinity);
  for (const node of input.nodes) {
    if (node.kind !== "shop" || node.brandIndex === undefined || !node.openIntervals) continue;
    for (const [start] of node.openIntervals) {
      latestByBrand[node.brandIndex] = Math.max(latestByBrand[node.brandIndex]!, start);
    }
  }
  const result = new Float64Array(1 << brandCount);
  for (let mask = 0; mask < result.length; mask++) {
    let latest = -Infinity;
    for (let b = 0; b < brandCount; b++) {
      if ((mask & (1 << b)) === 0) latest = Math.max(latest, latestByBrand[b]!);
    }
    result[mask] = latest;
  }
  return result;
}

/**
 * Mixed-radix code per shop so that the sum over visited shops identifies the
 * shop set (one shop per brand): shop j of brand b contributes
 * (j + 1) * prod_{b' < b} (shopsOf(b') + 1).
 */
function shopSignatures(input: SolverInput): number[] {
  const counts = new Array<number>(input.brands.length).fill(0);
  const local = input.nodes.map((node) =>
    node.kind === "shop" && node.brandIndex !== undefined ? ++counts[node.brandIndex]! : 0,
  );
  const radix: number[] = [];
  let product = 1;
  for (const count of counts) {
    radix.push(product);
    product *= count + 1;
  }
  if (product > Number.MAX_SAFE_INTEGER) throw new Error("Too many candidates to tell shop sets apart");
  return input.nodes.map((node, i) =>
    node.kind === "shop" && node.brandIndex !== undefined ? local[i]! * radix[node.brandIndex]! : 0,
  );
}

/** Rebuilds the detailed legs of a goal label by replaying its itinerary. */
function replay(input: SolverInput, goal: Label): Tour {
  const steps: ItineraryStep[] = [];
  for (let l: Label | null = goal; l && l.mode; l = l.parent) steps.push({ to: l.pos, mode: l.mode });
  const result = simulateItinerary(input, steps.reverse());
  if (!result.ok) throw new Error("Internal error: solver produced an invalid itinerary");
  return result.tour;
}

/**
 * Consistent lower bound on the remaining cost:
 * - each brand still to do costs at least its dwell plus the cheapest leg
 *   into one of its shops (from any node not of that brand);
 * - if we are away from home, or the car is, at least one more leg into home
 *   is needed (a drive leg if the car is away).
 * Every leg decreases the bound by at most its own cost, so A* stays exact.
 */
function buildHeuristic(input: SolverInput): (pos: number, car: number, mask: number) => number {
  const n = input.nodes.length;
  const brandCount = input.brands.length;
  const minIn = new Array<number>(brandCount).fill(Infinity);
  let minIntoHome = Infinity;
  let minDriveIntoHome = Infinity;

  for (const mode of MODES) {
    const matrix = input.matrices[mode];
    if (!matrix) continue;
    const coef = input.coefficients[mode];
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        const travel = matrix[from]![to];
        if (from === to || travel === null || travel === undefined) continue;
        const cost = travel * coef + (mode === "drive" ? parkingPenaltyAt(input, to) : 0);
        const target = input.nodes[to]!;
        if (to === input.homeIndex) {
          minIntoHome = Math.min(minIntoHome, cost);
          if (mode === "drive") minDriveIntoHome = Math.min(minDriveIntoHome, cost);
        }
        if (target.kind === "shop" && target.brandIndex !== undefined) {
          if (input.nodes[from]!.brandIndex === target.brandIndex && input.nodes[from]!.kind === "shop") continue;
          minIn[target.brandIndex] = Math.min(minIn[target.brandIndex]!, cost);
        }
      }
    }
  }

  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const perBrand = minIn.map((v) => finite(v) + input.dwellMinutes);
  const remainingByMask = new Float64Array(1 << brandCount);
  for (let mask = 0; mask < remainingByMask.length; mask++) {
    let sum = 0;
    for (let b = 0; b < brandCount; b++) if ((mask & (1 << b)) === 0) sum += perBrand[b]!;
    remainingByMask[mask] = sum;
  }
  const backHome = finite(minIntoHome);
  const driveBackHome = Math.max(backHome, finite(minDriveIntoHome));
  const home = input.homeIndex;

  return (pos, car, mask) => {
    let h = remainingByMask[mask]!;
    if (car !== NO_CAR && car !== home) h += driveBackHome;
    else if (pos !== home) h += backHome;
    return h;
  };
}

/**
 * For each non-drive edge, marks a mode as skippable when another non-drive
 * mode is at least as fast and at least as cheap (ties keep walking). Such a
 * leg can never improve a tour, and listing it would only clutter the top-k
 * with strictly worse copies of the same itinerary.
 */
function dominatedNonDriveModes(input: SolverInput): Partial<Record<Mode, boolean[][]>> {
  const walk = input.matrices.walk;
  const transit = input.matrices.transit;
  if (!walk || !transit) return {};
  const n = input.nodes.length;
  const cw = input.coefficients.walk;
  const ct = input.coefficients.transit;
  const skipWalk: boolean[][] = [];
  const skipTransit: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    skipWalk.push(new Array<boolean>(n).fill(false));
    skipTransit.push(new Array<boolean>(n).fill(false));
    for (let j = 0; j < n; j++) {
      const w = walk[i]![j];
      const t = transit[i]![j];
      if (w === null || w === undefined || t === null || t === undefined) continue;
      if (w <= t && w * cw <= t * ct) skipTransit[i]![j] = true;
      else if (t <= w && t * ct <= w * cw) skipWalk[i]![j] = true;
    }
  }
  return { walk: skipWalk, transit: skipTransit };
}

function brandsWithoutCandidates(input: SolverInput): number[] {
  const seen = new Set<number>();
  for (const node of input.nodes) {
    if (node.kind === "shop" && node.brandIndex !== undefined) seen.add(node.brandIndex);
  }
  return input.brands.map((_, i) => i).filter((i) => !seen.has(i));
}

/**
 * Cheap necessary condition: a brand is unreachable if none of its shops is
 * open long enough for a visit, or has both an incoming and an outgoing route.
 */
function brandsUnreachable(input: SolverInput): number[] {
  const n = input.nodes.length;
  const matrices = MODES.map((m) => input.matrices[m]).filter((m) => m !== undefined);
  const hasRoute = (from: number, to: number) =>
    matrices.some((m) => {
      const v = m[from]?.[to];
      return v !== null && v !== undefined;
    });
  const reachable = new Set<number>();
  input.nodes.forEach((node, idx) => {
    if (node.kind !== "shop" || node.brandIndex === undefined) return;
    if (earliestStart(node.openIntervals, 0, input.dwellMinutes) === null) return;
    let inbound = false;
    let outbound = false;
    for (let j = 0; j < n && !(inbound && outbound); j++) {
      if (j === idx) continue;
      inbound ||= hasRoute(j, idx);
      outbound ||= hasRoute(idx, j);
    }
    if (inbound && outbound) reachable.add(node.brandIndex);
  });
  return input.brands.map((_, i) => i).filter((i) => !reachable.has(i));
}

function validate(input: SolverInput): void {
  const n = input.nodes.length;
  if (input.homeIndex < 0 || input.homeIndex >= n) throw new Error("homeIndex out of range");
  if (input.nodes[input.homeIndex]!.kind !== "home") throw new Error("homeIndex must point to the home node");
  if (input.brands.length > MAX_BRANDS) throw new Error(`At most ${MAX_BRANDS} brands are supported`);
  for (const node of input.nodes) {
    if (node.kind !== "shop") continue;
    const b = node.brandIndex;
    if (b === undefined || !Number.isInteger(b) || b < 0 || b >= input.brands.length) {
      throw new Error(`Shop ${node.id} has an invalid brandIndex`);
    }
  }
  const modes = MODES.filter((m) => input.matrices[m] !== undefined);
  if (modes.length === 0) throw new Error("At least one mode must be allowed");
  for (const mode of modes) {
    const coef = input.coefficients[mode];
    if (!Number.isFinite(coef) || coef < 0) throw new Error(`Invalid coefficient for ${mode}`);
    const matrix = input.matrices[mode]!;
    if (matrix.length !== n || matrix.some((row) => row.length !== n)) {
      throw new Error(`Matrix for ${mode} must be ${n}x${n}`);
    }
    for (const row of matrix) {
      for (const v of row) {
        if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`Invalid travel time in ${mode} matrix`);
      }
    }
  }
  if (input.dwellMinutes < 0 || input.parkingPenaltyMinutes < 0 || (input.waitCostPerMinute ?? 0) < 0) throw new Error("Negative durations are not allowed");
}
