/**
 * Travel-time cache. Values are minutes, or null for "no route". Implemented
 * in memory for tests and dev; the production adapter (Upstash Redis) must
 * persist across requests, since serverless memory does not.
 */
export interface TravelTimeCache {
  getMany(keys: readonly string[]): Promise<Map<string, number | null>>;
  setMany(entries: ReadonlyMap<string, number | null>, ttlSeconds: number): Promise<void>;
}

/** Google's terms limit caching; 30 days also keeps times reasonably fresh. */
export const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;
