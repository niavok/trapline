/**
 * Road classes kept from OpenStreetMap, grouped for calibration: there are
 * only a few dozen reference trips, so each group gets a single speed.
 */
export const ROAD_GROUPS = ["motorway", "trunk", "primary", "secondary", "tertiary", "local"] as const;
export type RoadGroup = (typeof ROAD_GROUPS)[number];

export const HIGHWAY_TO_GROUP: Readonly<Record<string, RoadGroup>> = {
  motorway: "motorway",
  motorway_link: "motorway",
  trunk: "trunk",
  trunk_link: "trunk",
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  unclassified: "local",
  residential: "local",
  living_street: "local",
};

export const groupIndex = (group: RoadGroup): number => ROAD_GROUPS.indexOf(group);

/** Driving time model on the graph; every term is in minutes. */
export interface DriveParams {
  /** Minutes per km for each road group (index = ROAD_GROUPS order). */
  minutesPerKm: number[];
  /** Per traffic light crossed. */
  signalMinutes: number;
  /** Per junction crossed (graph node with 3+ connections). */
  junctionMinutes: number;
  /** Per trip: starting, leaving the street, final manoeuvres. */
  fixedMinutes: number;
  /** From a point to its nearest graph node and back: crow-fly at this speed. */
  accessKmh: number;
}

const pace = (kmh: number) => 60 / kmh;

/** Uncalibrated guesses (average effective speeds including slowdowns). */
export const DEFAULT_DRIVE_PARAMS: DriveParams = {
  minutesPerKm: [pace(90), pace(70), pace(40), pace(32), pace(28), pace(20)],
  signalMinutes: 0.35,
  junctionMinutes: 0.05,
  fixedMinutes: 2,
  accessKmh: 15,
};
