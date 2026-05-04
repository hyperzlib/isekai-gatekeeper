import type Koa from "koa";
import { timingSafeEqual } from "../lib/crypto.ts";
import type { CacheService } from "../services/cacheService.ts";
import type { AppConfig } from "../types/config.ts";

/**
 * DELETE /api/v1/cache
 *
 * 请求体：
 * - `{"url": "/wiki/PageName"}` — 精确删除单条
 * - `{"prefix": "/wiki/Category:"}` — 前缀批量删除
 */
export const deleteCache = async (ctx: Koa.Context) => {
  const apiKey = ctx.headers["x-api-key"];
  if (typeof apiKey !== "string" || !timingSafeEqual(apiKey, ctx.appConfig.api.key)) {
    ctx.status = 401;
    ctx.body = { error: "Unauthorized" };
    return;
  }

  const body = ctx.request.body as Record<string, unknown>;

  if (typeof body["url"] === "string") {
    ctx.appCache.delete(body["url"]);
    ctx.body = { deleted: 1 };
    return;
  }

  if (typeof body["prefix"] === "string") {
    const count = ctx.appCache.deleteByPrefix(body["prefix"]);
    ctx.body = { deleted: count };
    return;
  }

  ctx.status = 400;
  ctx.body = { error: "Request body must contain 'url' or 'prefix'" };
};