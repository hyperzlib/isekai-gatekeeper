/** 缓存条目结构 */
export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  cachedAt: number;
  ttl: number;
  tags?: string[];
}

export interface ICacheStore {
  init(): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, resp: T, ttl?: number, tags?: string[]): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>;
  deleteByTag(tag: string): Promise<number>;
  listByTag(tag: string): Promise<string[]>;
  listByPrefix(prefix: string): Promise<string[]>;
  cleanExpiredTagIndices(): Promise<number>;
}

/** 页面缓存键 */
export type CacheKeyModeType = "path" | "path+query";