import { Context } from "koa";
import { RateLimitGroupBy } from "../services/rateLimitService";

/**
 * 用于规则表达式中限流相关规则
 */
export class RuleRateLimit {
  private requestNumCache: Record<string, number> = {};

  constructor(private readonly ctx: Context) { }

  public async isLimited(groupBy: RateLimitGroupBy, maxRequests: number = 10, windowSec: number = 60): Promise<boolean> {
    const cacheKey = `${groupBy}:${windowSec}`;
    if (this.requestNumCache[cacheKey] !== undefined) {
      return this.requestNumCache[cacheKey] >= maxRequests;
    }

    const key = this.ctx.rateLimitService.buildGroupKey(this.ctx, groupBy);
    const result = await this.ctx.rateLimitService.consume({ key, windowSec, maxRequests });
    this.requestNumCache[cacheKey] = result.current;
    return result.limited;
  }

  public async reset(groupBy: RateLimitGroupBy, windowSec?: number): Promise<void> {
    const key = this.ctx.rateLimitService.buildGroupKey(this.ctx, groupBy);
    await this.ctx.rateLimitService.reset(key, windowSec);
    if (windowSec !== undefined) {
      const cacheKey = `${groupBy}:${windowSec}`;
      delete this.requestNumCache[cacheKey];
    } else {
      // 删除所有相关缓存
      for (const cacheKey in this.requestNumCache) {
        if (cacheKey.startsWith(`${groupBy}:`)) {
          delete this.requestNumCache[cacheKey];
        }
      }
    }
  }
}
