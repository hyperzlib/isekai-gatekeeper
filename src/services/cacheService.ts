import { CacheStore } from "../lib/cacheStore.ts";
import type { CachedResponse } from "../lib/cacheStore.ts";
import type { AppConfig } from "../types/config.ts";

export type { CachedResponse };

export class CacheService {
  readonly store: CacheStore;

  constructor(cfg: AppConfig) {
    this.store = new CacheStore(cfg.cache.max_entries, cfg.cache.max_body_bytes);
  }

  get(key: string): CachedResponse | null {
    return this.store.get(key);
  }

  set(key: string, resp: CachedResponse): void {
    this.store.set(key, resp);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  deleteByPrefix(prefix: string): number {
    return this.store.deleteByPrefix(prefix);
  }
}
