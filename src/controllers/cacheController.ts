import type Koa from "koa";
import { timingSafeEqual } from "../utils/crypto.ts";
import { makePageCacheKey } from "../utils/cache.ts";

function ensureAdminAuthorized(ctx: Koa.Context): boolean {
  const apiKey = ctx.headers["x-api-key"];
  if (typeof apiKey !== "string" || !timingSafeEqual(apiKey, ctx.appConfig.api.key)) {
    ctx.status = 401;
    ctx.body = { error: "Unauthorized" };
    return false;
  }
  return true;
}

function resolveSiteIdByHostname(ctx: Koa.Context, hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  for (const [siteId, siteConfig] of Object.entries(ctx.appConfig.sites)) {
    if (Array.isArray(siteConfig.hostname)) {
      if (siteConfig.hostname.includes(normalized)) {
        return siteId;
      }
    } else if (typeof siteConfig.hostname === "string") {
      if (siteConfig.hostname === normalized) {
        return siteId;
      }
    }
  }
  return null;
}

/**
 * POST /api/v1/delete_cache
 *
 * 请求体：
 * - `{"site": "example", "path": "/wiki/PageName"}` — 按 path 删除
 * - `{"site": "example", "prefix": "/wiki/Category:"}` — 按前缀批量删除
 * - `{"url": "(https://)example.com/wiki/PageName"}` — 按完整 URL 删除
 * - `{"urlPrefix": "(https://)example.com/wiki/Category:"}` — 按 URL 前缀批量删除
 * 
 * 请求必须包含有效的 API Key（通过 `x-api-key` 请求头提供）。
 */
export const deleteCache = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

  if (typeof body["site"] === "string" && typeof body["path"] === "string") {
    const keyPrefix = makePageCacheKey(body["site"], body["path"], "", "path");
    let count = await ctx.cacheService.deleteByPrefix(keyPrefix);
    const keyPrefixWithQuery = keyPrefix + ":?";
    count += await ctx.cacheService.deleteByPrefix(keyPrefixWithQuery);
    ctx.body = { deleted: count };
    return;
  }

  if (typeof body["site"] === "string" && typeof body["prefix"] === "string") {
    const keyPrefix = makePageCacheKey(body["site"], body["prefix"], "", "path");
    const count = await ctx.cacheService.deleteByPrefix(keyPrefix);
    ctx.body = { deleted: count };
    return;
  }

  if (typeof body["url"] === "string") {
    let parsed: URL;
    try {
      parsed = new URL(body["url"]);
    } catch {
      ctx.status = 400;
      ctx.body = { error: "Invalid 'url'" };
      return;
    }

    const site = resolveSiteIdByHostname(ctx, parsed.hostname);
    if (!site) {
      ctx.status = 400;
      ctx.body = { error: "No site matched by URL hostname" };
      return;
    }

    const key = makePageCacheKey(site, parsed.pathname, parsed.search, ctx.appConfig.cache.cache_key_mode);
    await ctx.cacheService.delete(key);
    ctx.body = { deleted: 1 };
    return;
  }

  if (typeof body["urlPrefix"] === "string") {
    let parsed: URL;
    try {
      parsed = new URL(body["urlPrefix"]);
    } catch {
      ctx.status = 400;
      ctx.body = { error: "Invalid 'urlPrefix'" };
      return;
    }

    const site = resolveSiteIdByHostname(ctx, parsed.hostname);
    if (!site) {
      ctx.status = 400;
      ctx.body = { error: "No site matched by URL prefix hostname" };
      return;
    }

    const keyPrefix = makePageCacheKey(site, parsed.pathname, "", "path");
    const count = await ctx.cacheService.deleteByPrefix(keyPrefix);
    ctx.body = { deleted: count };
    return;
  }

  ctx.status = 400;
  ctx.body = {
    error:
      "Request body must contain one of: ('site' + 'path'), ('site' + 'prefix'), 'url', or 'urlPrefix'",
  };
};

export const getRawCache = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const key = body["key"];
  if (typeof key !== "string" || key.length === 0) {
    ctx.status = 400;
    ctx.body = { error: "Invalid 'key'" };
    return;
  }

  const value = await ctx.cacheService.get<unknown>(key);
  ctx.body = { key, hit: value !== null, value };
};

export const setRawCache = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const key = body["key"];
  if (typeof key !== "string" || key.length === 0) {
    ctx.status = 400;
    ctx.body = { error: "Invalid 'key'" };
    return;
  }

  const ttl = body["ttl"];
  const ttlSec = typeof ttl === "number" && Number.isFinite(ttl) ? Math.max(1, Math.floor(ttl)) : undefined;
  await ctx.cacheService.set(key, body["value"], ttlSec);
  ctx.body = { ok: true, key, ttl: ttlSec ?? null };
};

export const deleteRawCache = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const key = body["key"];
  if (typeof key !== "string" || key.length === 0) {
    ctx.status = 400;
    ctx.body = { error: "Invalid 'key'" };
    return;
  }

  await ctx.cacheService.delete(key);
  ctx.body = { ok: true, key };
};

export const deleteRawCacheByPrefix = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const prefix = body["prefix"];
  if (typeof prefix !== "string" || prefix.length === 0) {
    ctx.status = 400;
    ctx.body = { error: "Invalid 'prefix'" };
    return;
  }

  const deleted = await ctx.cacheService.deleteByPrefix(prefix);
  ctx.body = { ok: true, prefix, deleted };
};

export const getRawCacheSize = async (ctx: Koa.Context) => {
  if (!ensureAdminAuthorized(ctx)) return;

  const cacheWithSize = ctx.cacheService as unknown as { size?: () => Promise<number> };
  if (!cacheWithSize.size) {
    ctx.status = 501;
    ctx.body = { error: "Current cache provider does not expose size()" };
    return;
  }

  const size = await cacheWithSize.size();
  ctx.body = { size };
};