import type { Mode } from "@/lib/solver";
import type { LatLng } from "./geo";

/**
 * Fixed square grid (~400 m, about 5 minutes on foot) used to share measured
 * travel times between nearby points and across requests: once "home ->
 * Chatelet" is known, any shop in the Chatelet cell reuses it.
 */
export const ZONE_SIZE_M = 400;
const REFERENCE_LAT = 48.85; // Ile-de-France, keeps cells roughly square
const LAT_STEP = ZONE_SIZE_M / 111_320;
const LNG_STEP = ZONE_SIZE_M / (111_320 * Math.cos((REFERENCE_LAT * Math.PI) / 180));

export function zoneOf(p: LatLng): string {
  return `${Math.floor(p.lat / LAT_STEP)}:${Math.floor(p.lng / LNG_STEP)}`;
}

export type TimeSlot = "weekday-peak" | "weekday-offpeak" | "saturday" | "sunday";

/** Coarse traffic / service slot of a departure time, in Paris local time. */
export function timeSlotOf(date: Date): TimeSlot {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat") return "saturday";
  if (weekday === "Sun") return "sunday";
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const peak = (minutes >= 7 * 60 && minutes < 10 * 60) || (minutes >= 16 * 60 + 30 && minutes < 19 * 60 + 30);
  return peak ? "weekday-peak" : "weekday-offpeak";
}

/**
 * Cache key of a leg between two zones. Null when both ends share a zone: the
 * zone-to-zone time would be meaningless there, such legs are not shared.
 */
export function travelCacheKey(mode: Mode, slot: TimeSlot, from: LatLng, to: LatLng): string | null {
  const a = zoneOf(from);
  const b = zoneOf(to);
  if (a === b) return null;
  return `tt:v1:${mode}:${slot}:${a}>${b}`;
}
