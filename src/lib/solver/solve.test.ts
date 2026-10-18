import { describe, expect, it } from "vitest";
import { itineraryOf, simulateItinerary } from "./simulate";
import { solve } from "./solve";
import { makeInput, route, table } from "./testUtils";
import type { SolveResult, SolverNode, Tour } from "./types";

function expectOk(result: SolveResult): Tour[] {
  if (result.status !== "ok") throw new Error(`Expected ok, got ${result.status}`);
  return result.tours;
}

const home: SolverNode = { id: "H", kind: "home" };
const shop = (id: string, brandIndex: number, extra: Partial<SolverNode> = {}): SolverNode => ({
  id,
  kind: "shop",
  brandIndex,
  ...extra,
});

describe("solve", () => {
  it("finds the best all-walk tour and ranks the alternatives", () => {
    const nodes = [home, shop("A1", 0), shop("A2", 0), shop("B1", 1)];
    const walk = table(
      {
        "H-A1": 10,
        "H-A2": 30,
        "A1-B1": 15,
        "A2-B1": 5,
        "A1-A2": 20,
        "H-B1": 20,
        "B1-H": 25,
      },
      null,
    );
    const input = makeInput(nodes, ["A", "B"], { walk });

    const tours = expectOk(solve(input));

    expect(route(input, tours[0]!.legs)).toEqual(["H>B1:walk", "B1>A1:walk", "A1>H:walk"]);
    // 45 walking minutes * 0.8 + 2 visits * 10 min.
    expect(tours[0]!.cost).toBeCloseTo(56);
    expect(tours[0]!.durationMinutes).toBe(65);
    expect(tours[0]!.travelMinutesByMode).toEqual({ walk: 45, transit: 0, drive: 0 });
    // Only 4 distinct tours exist (one shop per brand, no detours on foot).
    expect(tours.map((t) => t.cost)).toEqual([56, 60, 64, 68].map((c) => expect.closeTo(c)));
  });

  it("drives a simple loop and does not pay parking at home", () => {
    const nodes = [home, shop("A", 0), shop("B", 1)];
    const input = makeInput(nodes, ["A", "B"], {
      drive: table({ "H-A": 15, "H-B": 20, "A-B": 10 }, null),
      transit: table({}, 45),
      walk: table({}, 120),
    });

    const [best] = expectOk(solve(input));

    expect(best!.legs.every((l) => l.mode === "drive")).toBe(true);
    // 45 driving minutes * 1.2 + 2 parkings * 12 + 2 visits * 10.
    expect(best!.cost).toBeCloseTo(98);
    expect(best!.legs.map((l) => l.parkingMinutes)).toEqual([12, 12, 0]);
    expect(best!.legs.at(-1)!.to).toBe(input.homeIndex);
  });

  it("parks at a mall, walks two shops, takes the metro to a third and back to the car", () => {
    const nodes: SolverNode[] = [
      home,
      { id: "P", kind: "parking", parkingPenaltyMinutes: 0 },
      shop("A", 0),
      shop("B", 1),
      shop("C", 2),
    ];
    const input = makeInput(nodes, ["A", "B", "C"], {
      drive: table({ "H-P": 20, "H-A": 21, "H-B": 21, "H-C": 45, "P-C": 40, "A-C": 40, "B-C": 40 }, 3),
      walk: table({ "P-A": 4, "P-B": 5, "A-B": 3 }, 200),
      transit: table(
        { "B-C": 15, "C-B": 15, "A-C": 18, "C-A": 18, "P-C": 16, "C-P": 14, "P-A": 10, "P-B": 10, "A-B": 10 },
        60,
      ),
    });

    const tours = expectOk(solve(input));

    expect(route(input, tours[0]!.legs)).toEqual([
      "H>P:drive",
      "P>A:walk",
      "A>B:walk",
      "B>C:transit",
      "C>P:transit",
      "P>H:drive",
    ]);
    // 40 driving * 1.2 + 7 walking * 0.8 + 29 transit + 3 visits * 10, free parking.
    expect(tours[0]!.cost).toBeCloseTo(48 + 5.6 + 29 + 30);
    expect(tours[0]!.travelMinutesByMode).toEqual({ walk: 7, transit: 29, drive: 40 });
    expect(tours).toHaveLength(5);
    for (let i = 1; i < tours.length; i++) {
      expect(tours[i]!.cost).toBeGreaterThanOrEqual(tours[i - 1]!.cost);
    }
  });

  it("skips a shop that is closed when we would get there", () => {
    const nodes = [
      home,
      shop("A1", 0, { openIntervals: [[0, 5]] }), // closes before we can finish shopping
      shop("A2", 0, { openIntervals: [[0, 600]] }),
    ];
    const input = makeInput(nodes, ["A"], { walk: table({ "H-A1": 5, "H-A2": 20, "A1-A2": 15 }, null) });

    const tours = expectOk(solve(input));

    expect(tours).toHaveLength(1);
    expect(route(input, tours[0]!.legs)).toEqual(["H>A2:walk", "A2>H:walk"]);
  });

  it("orders visits to respect closing times even when it costs more", () => {
    const nodes = [home, shop("A", 0), shop("B", 1, { openIntervals: [[0, 30]] })];
    const walk = table({ "H-A": 5, "A-B": 10, "H-B": 15, "B-H": 15, "A-H": 5 }, null);
    const input = makeInput(nodes, ["A", "B"], { walk });

    const tours = expectOk(solve(input));

    // H>A>B>H would reach B at 25 and finish at 35 > 30, so only B first works.
    expect(tours).toHaveLength(1);
    expect(route(input, tours[0]!.legs)).toEqual(["H>B:walk", "B>A:walk", "A>H:walk"]);
  });

  it("waits for opening and charges the wait as unweighted time", () => {
    const nodes = [home, shop("A", 0, { openIntervals: [[30, 600]] })];
    const input = makeInput(nodes, ["A"], { walk: table({ "H-A": 10 }, null) });

    const [best] = expectOk(solve(input));

    expect(best!.waitMinutes).toBe(20);
    expect(best!.legs[0]!.readyAt).toBe(40);
    expect(best!.cost).toBeCloseTo(20 * 0.8 + 20 + 10);
    expect(best!.durationMinutes).toBe(50);
  });

  it("reports brands without any candidate", () => {
    const nodes = [home, shop("A", 0)];
    const input = makeInput(nodes, ["A", "B"], { walk: table({}, 10) });

    expect(solve(input)).toEqual({ status: "no-candidates", brands: [1] });
  });

  it("reports brands whose candidates have no route or are always closed", () => {
    const nodes = [home, shop("A", 0), shop("B1", 1), shop("B2", 1, { openIntervals: [] })];
    const walk = table({ "H-A": 10 }, null); // B1 has no route at all
    const input = makeInput(nodes, ["A", "B"], { walk });

    expect(solve(input)).toEqual({ status: "unreachable", brands: [1] });
  });

  it("is infeasible when a reachable shop cannot be reached before it closes", () => {
    const nodes = [home, shop("A", 0, { openIntervals: [[0, 20]] })];
    const input = makeInput(nodes, ["A"], { walk: table({ "H-A": 15 }, null) });

    expect(solve(input)).toMatchObject({ status: "infeasible" });
  });

  it("always brings the car back home", () => {
    // Coming back by transit would be cheaper, but the car would stay at A.
    const nodes = [home, shop("A", 0)];
    const input = makeInput(nodes, ["A"], {
      drive: table({ "H-A": 10, "A-H": 40 }, null),
      transit: table({ "H-A": 60, "A-H": 10 }, null),
    });

    const tours = expectOk(solve(input));

    for (const tour of tours) {
      const lastDrive = tour.legs.filter((l) => l.mode === "drive").at(-1);
      if (lastDrive) expect(lastDrive.to).toBe(input.homeIndex);
    }
    expect(route(input, tours[0]!.legs)).toEqual(["H>A:transit", "A>H:transit"]);
  });

  it("can walk back home mid-tour to pick up the car", () => {
    // A closes early, so it must come first; it sits in a no-car zone.
    const nodes = [home, shop("A", 0, { openIntervals: [[0, 20]] }), shop("B", 1)];
    const input = makeInput(nodes, ["A", "B"], {
      walk: table({ "H-A": 2 }, 300),
      drive: table({ "H-B": 15, "A-B": 15, "H-A": 50 }, null),
    });

    const [best] = expectOk(solve(input));

    expect(route(input, best!.legs)).toEqual(["H>A:walk", "A>H:walk", "H>B:drive", "B>H:drive"]);
  });

  it("returns an empty tour when there is nothing to buy", () => {
    const input = makeInput([home], [], { walk: table({}, null) });

    const tours = expectOk(solve(input));

    expect(tours).toHaveLength(1);
    expect(tours[0]!.legs).toEqual([]);
  });

  it("produces tours that replay identically through the simulator", () => {
    const nodes: SolverNode[] = [
      home,
      { id: "P", kind: "parking" },
      shop("A", 0, { openIntervals: [[20, 200]] }),
      shop("B", 1),
    ];
    const input = makeInput(nodes, ["A", "B"], {
      drive: table({ "H-P": 10, "H-A": 12, "H-B": 25 }, 8),
      walk: table({ "P-A": 5, "P-B": 9 }, 60),
      transit: table({}, 20),
    });

    for (const tour of expectOk(solve(input))) {
      const replay = simulateItinerary(input, itineraryOf(tour));
      expect(replay).toEqual({ ok: true, tour });
    }
  });

  it("rejects malformed input", () => {
    const input = makeInput([home, shop("A", 0)], ["A"], { walk: table({}, 5) });
    expect(() => solve({ ...input, coefficients: { ...input.coefficients, walk: -1 } })).toThrow();
    expect(() => solve({ ...input, matrices: { walk: [[0]] } })).toThrow();
    expect(() => solve({ ...input, matrices: {} })).toThrow();
  });
});

describe("simulateItinerary", () => {
  it("re-checks opening hours with refined leg times", () => {
    const nodes = [home, shop("A", 0, { openIntervals: [[0, 30]] })];
    const input = makeInput(nodes, ["A"], { transit: table({ "H-A": 10 }, null) });
    const steps = [
      { to: 1, mode: "transit" as const },
      { to: 0, mode: "transit" as const },
    ];

    // Refinement: the real transit leg is 25 min, 10 of which are walking.
    const refined = simulateItinerary(input, steps, (_from, _to, mode) => ({
      travelMinutes: 25,
      travelCost: 10 * input.coefficients.walk + 15 * input.coefficients[mode],
    }));
    expect(refined).toEqual({ ok: false, failedLeg: 0, reason: "invalid-move" });

    const ok = simulateItinerary(input, steps);
    expect(ok.ok && ok.tour.cost).toBeCloseTo(30);
  });

  it("refuses to drive when the car is elsewhere", () => {
    const nodes = [home, shop("A", 0), shop("B", 1)];
    const input = makeInput(nodes, ["A", "B"], { drive: table({}, 5), walk: table({}, 5) });
    const result = simulateItinerary(input, [
      { to: 1, mode: "drive" },
      { to: 0, mode: "walk" },
      { to: 2, mode: "drive" },
    ]);
    expect(result).toEqual({ ok: false, failedLeg: 2, reason: "invalid-move" });
  });
});
