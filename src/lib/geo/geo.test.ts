import { describe, expect, it } from "vitest";
import { MemoryTravelTimeCache } from "@/lib/cache/memory";
import { OPTIMISTIC_MODELS, crowFlyMatrices, crowFlyMinutes } from "./crowFly";
import { haversineKm } from "./geo";
import { timeSlotOf, travelCacheKey, zoneOf } from "./zones";

const chatelet = { lat: 48.8584, lng: 2.3474 };
const laDefense = { lat: 48.8919, lng: 2.2381 };

describe("crow-fly estimates", () => {
  it("measures distances", () => {
    expect(haversineKm(chatelet, laDefense)).toBeCloseTo(8.8, 1);
  });

  it("estimates walking and optimistic drive / transit times", () => {
    expect(crowFlyMinutes(OPTIMISTIC_MODELS.walk, chatelet, laDefense)).toBeCloseTo(143, 0);
    expect(crowFlyMinutes(OPTIMISTIC_MODELS.drive, chatelet, laDefense)).toBeCloseTo(7.9, 1);
    expect(crowFlyMinutes(OPTIMISTIC_MODELS.transit, chatelet, laDefense)).toBeCloseTo(13.8, 1);
  });

  it("builds square matrices with a zero diagonal", () => {
    const m = crowFlyMatrices([chatelet, laDefense], ["walk", "drive"]);
    expect(m.transit).toBeUndefined();
    expect(m.drive![0]![0]).toBe(0);
    expect(m.drive![0]![1]).toBeCloseTo(m.drive![1]![0]!);
  });
});

describe("zones", () => {
  it("puts close points in the same zone and far ones apart", () => {
    expect(zoneOf(chatelet)).toBe(zoneOf({ lat: 48.8585, lng: 2.3475 }));
    expect(zoneOf(chatelet)).not.toBe(zoneOf(laDefense));
  });

  it("does not build keys inside a single zone", () => {
    expect(travelCacheKey("drive", "sunday", chatelet, chatelet)).toBeNull();
    expect(travelCacheKey("drive", "sunday", chatelet, laDefense)).not.toBe(
      travelCacheKey("drive", "sunday", laDefense, chatelet),
    );
  });

  it("classifies departure times in Paris local time", () => {
    expect(timeSlotOf(new Date("2026-10-19T06:30:00Z"))).toBe("weekday-peak"); // Mon 08:30
    expect(timeSlotOf(new Date("2026-10-19T12:00:00Z"))).toBe("weekday-offpeak"); // Mon 14:00
    expect(timeSlotOf(new Date("2026-10-24T08:00:00Z"))).toBe("saturday");
    expect(timeSlotOf(new Date("2026-10-25T08:00:00Z"))).toBe("sunday");
    expect(timeSlotOf(new Date("2026-12-07T17:00:00Z"))).toBe("weekday-peak"); // Mon 18:00 (UTC+1)
  });
});

describe("MemoryTravelTimeCache", () => {
  it("expires entries", async () => {
    let now = 0;
    const cache = new MemoryTravelTimeCache(() => now);
    await cache.setMany(new Map([["a", 5], ["b", null]]), 60);
    expect(await cache.getMany(["a", "b", "c"])).toEqual(new Map([["a", 5], ["b", null]]));
    now = 61_000;
    expect(await cache.getMany(["a"])).toEqual(new Map());
  });
});
