import type { TravelTimeCache } from "./types";

export class MemoryTravelTimeCache implements TravelTimeCache {
  private readonly entries = new Map<string, { value: number | null; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async getMany(keys: readonly string[]): Promise<Map<string, number | null>> {
    const found = new Map<string, number | null>();
    const now = this.now();
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (entry.expiresAt <= now) this.entries.delete(key);
      else found.set(key, entry.value);
    }
    return found;
  }

  async setMany(entries: ReadonlyMap<string, number | null>, ttlSeconds: number): Promise<void> {
    const expiresAt = this.now() + ttlSeconds * 1000;
    for (const [key, value] of entries) this.entries.set(key, { value, expiresAt });
  }

  get size(): number {
    return this.entries.size;
  }
}
