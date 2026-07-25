import { MemoryCacheStore } from "../lib/memoryCacheStore.ts";
import { CachedResponse, ICacheStore } from "../types/cache.ts";
import type { AppConfig, CacheConfig } from "../types/config.ts";

export type { CachedResponse };

export class CacheService {
  readonly cacheConfig: CacheConfig;
  private store!: ICacheStore;

  constructor(cfg: AppConfig) {
    this.cacheConfig = cfg.cache;
  }

  public async init() {
    console.log("[cache] Initializing cache service with provider:", this.cacheConfig.provider);
    switch (this.cacheConfig.provider) {
      case "memory":
        const { MemoryCacheStore } = await import("../lib/memoryCacheStore.ts");
        this.store = new MemoryCacheStore(
          this.cacheConfig.max_entries,
          this.cacheConfig.max_body_bytes,
          this.cacheConfig.default_ttl
        );
        await this.store.init();
        break;
      case "bun+redis":
        if (!this.cacheConfig.bun_redis?.url) {
          throw new Error("Bun Redis cache provider requires cache.bun_redis.url configuration");
        }

        const { BunRedisCacheStore } = await import("../lib/bunRedisCacheStore.ts");
        this.store = new BunRedisCacheStore(
          this.cacheConfig.bun_redis.url,
          this.cacheConfig.max_body_bytes,
          this.cacheConfig.default_ttl
        );
        await this.store.init();
        break;
      default:
        throw new Error(`Unsupported cache provider: ${this.cacheConfig.provider}`);
    }
  }

  public get<T>(key: string): Promise<T | null> {
    return this.store.get<T>(key);
  }

  public set<T>(key: string, resp: T, ttl?: number, tags?: string[]): Promise<void> {
    return this.store.set<T>(key, resp, ttl, tags);
  }

  public delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  public deleteByPrefix(prefix: string): Promise<number> {
    return this.store.deleteByPrefix(prefix);
  }

  public deleteByTag(tag: string): Promise<number> {
    return this.store.deleteByTag(tag);
  }

  public listByTag(tag: string): Promise<string[]> {
    return this.store.listByTag(tag);
  }

  public listByPrefix(prefix: string): Promise<string[]> {
    return this.store.listByPrefix(prefix);
  }

  public cleanExpiredTagIndices(): Promise<number> {
    return this.store.cleanExpiredTagIndices();
  }
}
