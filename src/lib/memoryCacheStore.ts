import { ICacheStore } from "../types/cache";

interface CacheEntry {
  value: any;
  expiresAt?: number;
}

/**
 * 基于 LRU 的内存缓存存储。
 * 不依赖外部缓存库，以便控制 TTL 精度和 max_body_bytes 限制。
 */
export class MemoryCacheStore implements ICacheStore {
  private readonly store = new Map<string, CacheEntry>();
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
      this.store.delete(key);
      return null;
    }

    // LRU：移到末尾
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as T;
  }

  public async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (JSON.stringify(value).length > this.maxBodyBytes) return;

    // 若键已存在，先移除（以便重新插入到末尾）
    this.store.delete(key);

    // LRU 淘汰：超出容量时删除最早的条目
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
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
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * 删除所有以 prefix 开头的缓存条目，返回删除数量。
   */
  public async deleteByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  public async size(): Promise<number> {
    return this.store.size;
  }
}
