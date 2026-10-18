import { DEFAULT_TTL_SECONDS, type TravelTimeCache } from "@/lib/cache/types";
import type { LatLng } from "@/lib/geo/geo";
import { travelCacheKey, type TimeSlot } from "@/lib/geo/zones";
import { legKey, type LegRequest, type LegTimes, type TravelTimeSource } from "./lazySolve";

/** Measures legs for real (API call). Must return a value for every leg it could compute. */
export type LegFetcher = (legs: readonly LegRequest[]) => Promise<LegTimes>;

/**
 * Wraps a paid fetcher with the zone-to-zone cache: legs whose ends fall in
 * the same pair of zones share one measurement, within a request and across
 * requests.
 */
export function cachedSource(
  points: readonly LatLng[],
  slot: TimeSlot,
  cache: TravelTimeCache,
  fetcher: LegFetcher,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): TravelTimeSource {
  const cacheKey = (leg: LegRequest) => travelCacheKey(leg.mode, slot, points[leg.from]!, points[leg.to]!);

  return {
    async lookup(legs) {
      const keys = legs.map(cacheKey);
      const found = await cache.getMany(keys.filter((k): k is string => k !== null));
      const times: LegTimes = new Map();
      legs.forEach((leg, i) => {
        const key = keys[i];
        if (key && found.has(key)) times.set(legKey(leg), found.get(key)!);
      });
      return times;
    },

    async measure(legs) {
      // One representative leg per zone pair; legs without a zone key go alone.
      const groups = new Map<string, LegRequest[]>();
      for (const leg of legs) {
        const group = cacheKey(leg) ?? `solo:${legKey(leg)}`;
        const list = groups.get(group);
        if (list) list.push(leg);
        else groups.set(group, [leg]);
      }
      const representatives = [...groups.values()].map((group) => group[0]!);
      const fetched = await fetcher(representatives);

      const times: LegTimes = new Map();
      const toCache = new Map<string, number | null>();
      for (const [group, members] of groups) {
        const repKey = legKey(members[0]!);
        if (!fetched.has(repKey)) continue;
        const value = fetched.get(repKey)!;
        for (const member of members) times.set(legKey(member), value);
        if (!group.startsWith("solo:")) toCache.set(group, value);
      }
      if (toCache.size > 0) await cache.setMany(toCache, ttlSeconds);
      return times;
    },
  };
}
