import {
  CachedResponse,
  CachedResponseMeta,
  ConsumeRateLimitOptions,
  ConsumeRateLimitResult,
  ICacheStore,
} from "../types/cache";

interface CacheEntry {
  value: any;
  expiresAt?: number;
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
  firstLimitedMarked: boolean;
};

/**
 * 基于 LRU 的内存缓存存储。
 * 不依赖外部缓存库，以便控制 TTL 精度和 max_body_bytes 限制。
 */
export class MemoryCacheStore implements ICacheStore {
  private readonly store = new Map<string, CacheEntry>();
  /** tag → (cacheKey → expiresAt_ms) */
  private readonly tagIndex = new Map<string, Map<string, number>>();
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly defaultTtl: number;

  constructor(maxEntries: number, maxBodyBytes: number, defaultTtl: number = 300) {
    this.maxEntries = maxEntries;
    this.maxBodyBytes = maxBodyBytes;
    this.defaultTtl = defaultTtl;
  }

  public async init(): Promise<void> { }

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.removeCachedResponseTagIndices(key);
      this.store.delete(key);
      return null;
    }

    // LRU：移到末尾
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as T;
  }

  public async set<T>(key: string, value: T, ttl?: number, tags?: string[]): Promise<void> {
    if (JSON.stringify(value).length > this.maxBodyBytes) return;

    // 若键已存在，先清理旧 tag 索引
    this.removeCachedResponseTagIndices(key);
    this.store.delete(key);

    // LRU 淘汰：超出容量时删除最早的条目
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.removeCachedResponseTagIndices(firstKey);
        this.store.delete(firstKey);
      }
    }

    let effectiveTtl = ttl ?? this.defaultTtl;
    if (effectiveTtl <= 0) effectiveTtl = this.defaultTtl;

    let expiresAt: number | undefined = undefined;
    if (effectiveTtl > 0) {
      expiresAt = Date.now() + effectiveTtl * 1000;
    }

    this.store.set(key, {
      value,
      expiresAt,
    });

    // 写入 tag 索引
    if (tags && tags.length > 0 && expiresAt !== undefined) {
      for (const tag of tags) {
        let tagMap = this.tagIndex.get(tag);
        if (!tagMap) {
          tagMap = new Map();
          this.tagIndex.set(tag, tagMap);
        }
        tagMap.set(key, expiresAt);
      }
    }
  }

  public async getCachedResponseMeta(key: string): Promise<CachedResponseMeta | null> {
    const cached = await this.get<CachedResponse>(key);
    if (!cached) return null;
    const { body: _body, ...meta } = cached;
    return meta;
  }

  public async getCachedResponse(key: string): Promise<CachedResponse | null> {
    return this.get<CachedResponse>(key);
  }

  public async setCachedResponse(
    key: string,
    value: CachedResponse,
    ttl?: number,
    tags?: string[],
  ): Promise<void> {
    const effectiveTags = tags ?? value.tags;
    await this.set(key, { ...value, tags: effectiveTags }, ttl, effectiveTags);
  }

  public async deleteCachedResponse(key: string): Promise<void> {
    await this.delete(key);
  }

  public async consumeRateLimit(options: ConsumeRateLimitOptions): Promise<ConsumeRateLimitResult> {
    const windowMs = options.windowSec * 1000;
    const resetAt = Math.floor(options.now / windowMs) * windowMs + windowMs;

    const entry = this.store.get(options.key);
    let bucket = entry?.value as RateLimitBucket | undefined;
    if (
      !bucket ||
      typeof bucket.count !== "number" ||
      typeof bucket.resetAt !== "number" ||
      options.now >= bucket.resetAt
    ) {
      bucket = {
        count: 0,
        resetAt,
        firstLimitedMarked: false,
      };
    }

    bucket.count += options.cost;

    const limited = bucket.count > options.maxRequests;
    const firstLimitedInWindow = limited && !bucket.firstLimitedMarked;
    if (limited) {
      bucket.firstLimitedMarked = true;
    }

    const ttlSec = Math.max(1, Math.ceil((bucket.resetAt - options.now) / 1000));
    await this.set(options.key, bucket, ttlSec);

    return {
      current: bucket.count,
      limited,
      remaining: Math.max(0, options.maxRequests - bucket.count),
      resetAt: bucket.resetAt,
      firstLimitedInWindow,
    };
  }

  public async delete(key: string): Promise<void> {
    this.removeCachedResponseTagIndices(key);
    this.store.delete(key);
  }

  /**
   * 删除所有以 prefix 开头的缓存条目，返回删除数量。
   */
  public async deleteByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.removeCachedResponseTagIndices(key);
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  public async deleteByTag(tag: string): Promise<number> {
    const tagMap = this.tagIndex.get(tag);
    if (!tagMap) return 0;

    const now = Date.now();
    let deleted = 0;

    for (const [key, expiresAt] of tagMap) {
      if (expiresAt > now) {
        await this.deleteCachedResponse(key);
        deleted++;
      }
    }

    this.tagIndex.delete(tag);
    return deleted;
  }

  public async listByTag(tag: string): Promise<string[]> {
    const tagMap = this.tagIndex.get(tag);
    if (!tagMap) return [];

    const now = Date.now();
    const result: string[] = [];
    for (const [key, expiresAt] of tagMap) {
      if (expiresAt > now) {
        result.push(key);
      }
    }
    return result;
  }

  public async listByPrefix(prefix: string): Promise<string[]> {
    const result: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key);
      }
    }
    return result;
  }

  public async cleanExpiredTagIndices(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [tag, tagMap] of this.tagIndex) {
      for (const [key, expiresAt] of tagMap) {
        if (expiresAt <= now) {
          tagMap.delete(key);
          cleaned++;
        }
      }
      if (tagMap.size === 0) {
        this.tagIndex.delete(tag);
      }
    }

    return cleaned;
  }

  public async size(): Promise<number> {
    return this.store.size;
  }

  /** 从缓存对象声明的 tag 索引中移除指定 key */
  private removeCachedResponseTagIndices(key: string): void {
    const tags = this.getTagsForKey(key);
    if (tags.length === 0) return;

    for (const tag of tags) {
      const tagMap = this.tagIndex.get(tag);
      if (!tagMap) continue;
      tagMap.delete(key);
      if (tagMap.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
  }

  private getTagsForKey(key: string): string[] {
    const entry = this.store.get(key);
    const value = entry?.value as { tags?: unknown } | undefined;
    return Array.isArray(value?.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
  }
}
