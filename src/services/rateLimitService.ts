import type { Context } from "koa";
import { CacheService } from "./cacheService";

export type RateLimitGroupBy =
  | "ip"
  | "asn"
  | "country"
  | "ip+path"
  | "asn+path"
  | "country+path"
  | "client_id"
  | "client_id+path";

export interface ConsumeOptions {
  key: string;
  /** 窗口时长（秒） */
  windowSec: number;
  /** 窗口内允许的最大请求数 */
  maxRequests: number;
  /** 当前请求计数，默认 1 */
  cost?: number;
}

export interface ConsumeResult {
  key: string;
  windowSec: number;
  maxRequests: number;
  /** 当前窗口累计请求数（已包含本次） */
  current: number;
  /** 是否超限 */
  limited: boolean;
  /** 窗口剩余额度（最小为 0） */
  remaining: number;
  /** 当前窗口重置时间戳（毫秒） */
  resetAt: number;
  /** 首次超限时会记录 true，便于做一次性日志 */
  firstLimitedInWindow: boolean;
}

type Bucket = {
  count: number;
  resetAt: number;
  firstLimitedMarked: boolean;
};

const RATE_LIMIT_KEY_PREFIX = "rate_limit:";

/**
 * 内存固定窗口限流服务。
 *
 * 设计目标：
 * 1. 支持规则表达式中频繁调用（O(1)）
 * 2. 支持窗口自动切换与惰性过期
 */
export class RateLimitService {
  constructor(private readonly cacheService: CacheService) { }

  public init(): void {
    // cacheService 已处理 TTL 与存储生命周期，此处无需额外初始化
  }

  public close(): void {
    // 由外层 cacheService 统一管理资源
  }

  /**
   * 增加计数并返回本次消费后的限流结果。
   */
  public async consume(options: ConsumeOptions): Promise<ConsumeResult> {
    const key = options.key;
    const windowSec = Math.max(1, Math.floor(options.windowSec));
    const maxRequests = Math.max(1, Math.floor(options.maxRequests));
    const cost = Math.max(1, Math.floor(options.cost ?? 1));

    const now = Date.now();
    const windowMs = windowSec * 1000;
    const resetAt = this.getWindowResetAt(now, windowMs);

    const cacheKey = this.getBucketCacheKey(key, windowSec);
    let bucket = await this.cacheService.get<Bucket>(cacheKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: 0,
        resetAt,
        firstLimitedMarked: false,
      };
    }

    bucket.count += cost;

    const limited = bucket.count > maxRequests;
    const firstLimitedInWindow = limited && !bucket.firstLimitedMarked;
    if (limited) {
      bucket.firstLimitedMarked = true;
    }

    const ttlSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    await this.cacheService.set(cacheKey, bucket, ttlSec);

    return {
      key,
      windowSec,
      maxRequests,
      current: bucket.count,
      limited,
      remaining: Math.max(0, maxRequests - bucket.count),
      resetAt: bucket.resetAt,
      firstLimitedInWindow,
    };
  }

  /**
   * 判断是否超限（本质是 consume 的简化包装）。
   */
  public async isLimited(options: ConsumeOptions): Promise<boolean> {
    return (await this.consume(options)).limited;
  }

  /** 删除某个 key 的限流窗口。 */
  public async reset(key: string, windowSec?: number): Promise<void> {
    if (windowSec !== undefined) {
      const cacheKey = this.getBucketCacheKey(key, windowSec);
      await this.cacheService.delete(cacheKey);
    } else {
      const prefix = this.getBucketCacheKeyPrefix(key);
      await this.cacheService.deleteByPrefix(prefix);
    }
  }

  /** 清空所有限流状态。 */
  public async clear(): Promise<number> {
    return this.cacheService.deleteByPrefix(RATE_LIMIT_KEY_PREFIX);
  }

  /**
   * 按规则维度构造分组 key。
   *
   * 说明：
   * - ASN / country 缺失时会回退到 IP，避免把所有未知流量挤到同一个 key。
   * - path 使用 URL pathname，忽略 query（更稳态）。
   */
  public buildGroupKey(ctx: Context, groupBy: RateLimitGroupBy): string {
    const ip = (ctx.ip || "unknown").trim();
    const path = ctx.URL.pathname || "/";
    const asn = this.getAsn(ctx);
    const country = this.getCountryCode(ctx);
    const clientId = ctx.validatedClientId;

    switch (groupBy) {
      case "ip":
        return `ip:${ip}`;
      case "asn":
        return asn ? `asn:${asn}` : `ip:${ip}`;
      case "country":
        return country ? `country:${country}` : `ip:${ip}`;
      case "ip+path":
        return `ip:${ip}:path:${path}`;
      case "asn+path":
        return asn ? `asn:${asn}:path:${path}` : `ip:${ip}:path:${path}`;
      case "country+path":
        return country ? `country:${country}:path:${path}` : `ip:${ip}:path:${path}`;
      case "client_id":
        return clientId ? `client_id:${clientId}` : `ip:${ip}`;
      case "client_id+path":
        return clientId ? `client_id:${clientId}:path:${path}` : `ip:${ip}:path:${path}`;
      default:
        return `ip:${ip}`;
    }
  }

  private getWindowResetAt(nowMs: number, windowMs: number): number {
    const currentWindowStart = Math.floor(nowMs / windowMs) * windowMs;
    return currentWindowStart + windowMs;
  }

  private getBucketCacheKey(key: string, windowSec: number): string {
    return `${RATE_LIMIT_KEY_PREFIX}${key}:${windowSec}`;
  }

  private getBucketCacheKeyPrefix(key: string): string {
    return `${RATE_LIMIT_KEY_PREFIX}${key}:`;
  }

  private getAsn(ctx: Context): number | undefined {
    const asn = ctx.geoip?.asn;
    if (typeof asn === "number" && Number.isFinite(asn)) return asn;
    return undefined;
  }

  private getCountryCode(ctx: Context): string | undefined {
    const geoip = ctx.geoip as
      | { countryCode?: string; country_code?: string }
      | undefined;
    const code = geoip?.countryCode ?? geoip?.country_code;
    if (!code) return undefined;
    return String(code).toUpperCase();
  }
}

