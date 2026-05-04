/** 缓存条目结构 */
export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  cachedAt: number;
  ttl: number;
}

interface CacheEntry {
  resp: CachedResponse;
  expiresAt: number;
}

/**
 * 基于 LRU 的内存缓存存储。
 * 不依赖外部缓存库，以便控制 TTL 精度和 max_body_bytes 限制。
 */
export class CacheStore {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;

  constructor(maxEntries: number, maxBodyBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBodyBytes = maxBodyBytes;
  }

  get(key: string): CachedResponse | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // LRU：移到末尾
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.resp;
  }

  set(key: string, resp: CachedResponse): void {
    if (resp.body.byteLength > this.maxBodyBytes) return;

    // 若键已存在，先移除（以便重新插入到末尾）
    this.store.delete(key);

    // LRU 淘汰：超出容量时删除最早的条目
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }

    this.store.set(key, {
      resp,
      expiresAt: Date.now() + resp.ttl * 1000,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * 删除所有以 prefix 开头的缓存条目，返回删除数量。
   */
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  size(): number {
    return this.store.size;
  }
}
