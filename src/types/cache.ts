/** 缓存条目结构 */
export interface CachedResponseMeta {
  status: number;
  headers: Record<string, string | string[]>;
  cachedAt: number;
  ttl: number;
  tags?: string[];
}

export interface CachedResponse extends CachedResponseMeta {
  body: string;
}

export interface ConsumeRateLimitOptions {
  key: string;
  windowSec: number;
  maxRequests: number;
  cost: number;
  now: number;
}

export interface ConsumeRateLimitResult {
  current: number;
  limited: boolean;
  remaining: number;
  resetAt: number;
  firstLimitedInWindow: boolean;
}

export interface ICacheStore {
  init(): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, resp: T, ttl?: number, tags?: string[]): Promise<void>;
  getCachedResponseMeta(key: string): Promise<CachedResponseMeta | null>;
  getCachedResponse(key: string): Promise<CachedResponse | null>;
  setCachedResponse(key: string, resp: CachedResponse, ttl?: number, tags?: string[]): Promise<void>;
  deleteCachedResponse(key: string): Promise<void>;
  consumeRateLimit(options: ConsumeRateLimitOptions): Promise<ConsumeRateLimitResult>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>;
  deleteByTag(tag: string): Promise<number>;
  listByTag(tag: string): Promise<string[]>;
  listByPrefix(prefix: string): Promise<string[]>;
  cleanExpiredTagIndices(): Promise<number>;
}

/** 页面缓存键 */
export type CacheKeyModeType = "path" | "path+query";
