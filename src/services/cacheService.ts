import { MemoryCacheStore } from "./cacheStores/memoryCacheStore.ts";
import { CachedResponse, ICacheStore } from "../types/cache.ts";
import type { AppConfig, CacheConfig } from "../types/config.ts";

export type { CachedResponse };

export class CacheService {
  readonly cacheConfig: CacheConfig;
  private store!: ICacheStore;
  private readonly injectedStore?: ICacheStore;

  constructor(cfg: AppConfig, options?: { store?: ICacheStore }) {
    this.cacheConfig = cfg.cache;
    this.injectedStore = options?.store;
  }

  public async init() {
    if (this.injectedStore) {
      this.store = this.injectedStore;
      await this.store.init();
      return;
    }

    console.log("[cache] Initializing cache service with provider:", this.cacheConfig.provider);
    switch (this.cacheConfig.provider) {
      case "memory":
        const { MemoryCacheStore } = await import("./cacheStores/memoryCacheStore.ts");
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

        const { BunRedisCacheStore } = await import("./cacheStores/bunRedisCacheStore.ts");
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

  public set<T>(key: string, resp: T, ttl?: number): Promise<void> {
    return this.store.set<T>(key, resp, ttl);
  }

  public delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  public deleteByPrefix(prefix: string): Promise<number> {
    return this.store.deleteByPrefix(prefix);
  }

  public async size(): Promise<number> {
    const storeWithSize = this.store as unknown as { size?: () => Promise<number> };
    if (!storeWithSize.size) {
      throw new Error("Cache store does not support size()");
    }
    return storeWithSize.size();
  }
}
