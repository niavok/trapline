// Pure data model of the tour problem. Nothing here knows about Google APIs:
// travel times come in as plain matrices and times are minutes relative to
// the tour departure (t = 0).

export const MODES = ["walk", "transit", "drive"] as const;
export type Mode = (typeof MODES)[number];

/** Half-open interval [start, end) in minutes since departure. */
export type TimeInterval = readonly [start: number, end: number];

export type NodeKind = "home" | "shop" | "parking";

export interface SolverNode {
  id: string;
  kind: NodeKind;
  /** Index into `SolverInput.brands`; required for shops, ignored otherwise. */
  brandIndex?: number;
  /**
   * Opening intervals (minutes since departure). Undefined means "always open".
   * An empty array means "closed for the whole horizon".
   */
  openIntervals?: readonly TimeInterval[];
  /** Overrides the default parking penalty when arriving here by car. */
  parkingPenaltyMinutes?: number;
}

/**
 * Raw travel time in minutes, indexed [from][to]. `null` means "no route".
 * The diagonal is ignored.
 */
export type TravelMatrix = ReadonlyArray<ReadonlyArray<number | null>>;

export interface SolverInput {
  nodes: readonly SolverNode[];
  homeIndex: number;
  /** Brand labels; brand i is satisfied by visiting any shop with brandIndex i. */
  brands: readonly string[];
  /** One matrix per allowed mode. A missing mode is a forbidden mode. */
  matrices: Partial<Record<Mode, TravelMatrix>>;
  coefficients: Record<Mode, number>;
  /** Unweighted time spent in each shop that satisfies a brand. */
  dwellMinutes: number;
  /** Default penalty added on each car arrival (except at home). */
  parkingPenaltyMinutes: number;
  /** Number of best tours to return. */
  k: number;
  /** Safety valve against pathological inputs. */
  maxExpandedLabels?: number;
}

export interface Leg {
  from: number;
  to: number;
  mode: Mode;
  departAt: number;
  travelMinutes: number;
  parkingMinutes: number;
  waitMinutes: number;
  dwellMinutes: number;
  /** Time at which we leave `to` (after parking, waiting and shopping). */
  readyAt: number;
  /** Generalized cost of this leg, including parking, waiting and dwell. */
  cost: number;
  /** Brand satisfied at `to`, if any. */
  visitedBrand?: number;
}

export interface Tour {
  cost: number;
  /** Real elapsed minutes from departure to return home. */
  durationMinutes: number;
  travelMinutesByMode: Record<Mode, number>;
  waitMinutes: number;
  legs: Leg[];
}

export type SolveResult =
  | { status: "ok"; tours: Tour[]; expandedLabels: number; truncated: boolean }
  | { status: "no-candidates"; brands: number[] }
  | { status: "unreachable"; brands: number[] }
  | { status: "infeasible"; expandedLabels: number; truncated: boolean };
