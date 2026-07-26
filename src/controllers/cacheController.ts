import { timingSafeEqual } from "../lib/crypto.ts";
import { makePageCacheKey } from "../utils/cache.ts";
import type { AppContext } from "../types/hono.ts";

function resolveSiteIdByHost(ctx: AppContext, host: string, protocol: string): string | null {
  return ctx.get("siteResolver").resolveHost(host, protocol.replace(/:$/, ""))?.id ?? null;
}

async function parseJsonBody(ctx: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await ctx.req.json();
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * POST /api/v1/delete_cache
 *
 * 请求体：
 * - `{"site": "example", "path": "/wiki/PageName"}` — 按 path 删除
 * - `{"site": "example", "prefix": "/wiki/Category:"}` — 按前缀批量删除
 * - `{"url": "(https://)example.com/wiki/PageName"}` — 按完整 URL 删除
 * - `{"urlPrefix": "(https://)example.com/wiki/Category:"}` — 按 URL 前缀批量删除
 * - `{"tag": "wiki"}` — 按 tag 删除所有关联缓存
 * 
 * 请求必须包含有效的 API Key（通过 `x-api-key` 请求头提供）。
 */
export const deleteCache = async (ctx: AppContext) => {
  const appConfig = ctx.get("appConfig");
  const apiKey = ctx.req.header("x-api-key");
  if (typeof apiKey !== "string" || !timingSafeEqual(apiKey, appConfig.api.key)) {
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  const body = await parseJsonBody(ctx);

  if (typeof body["tag"] === "string") {
    const count = await ctx.get("cacheService").deleteByTag(body["tag"]);
    return ctx.json({ deleted: count });
  }

  if (typeof body["site"] === "string" && typeof body["path"] === "string") {
    const keyPrefix = makePageCacheKey(body["site"], body["path"], "", "path");
    let count = await ctx.get("cacheService").deleteByPrefix(keyPrefix);
    const keyPrefixWithQuery = keyPrefix + ":?";
    count += await ctx.get("cacheService").deleteByPrefix(keyPrefixWithQuery);
    return ctx.json({ deleted: count });
  }

  if (typeof body["site"] === "string" && typeof body["prefix"] === "string") {
    const keyPrefix = makePageCacheKey(body["site"], body["prefix"], "", "path");
    const count = await ctx.get("cacheService").deleteByPrefix(keyPrefix);
    return ctx.json({ deleted: count });
  }

  if (typeof body["url"] === "string") {
    let parsed: URL;
    try {
      parsed = new URL(body["url"]);
    } catch {
      return ctx.json({ error: "Invalid 'url'" }, 400);
    }

    const site = resolveSiteIdByHost(ctx, parsed.host, parsed.protocol);
    if (!site) {
      return ctx.json({ error: "No site matched by URL hostname" }, 400);
    }

    const key = makePageCacheKey(site, parsed.pathname, parsed.search, appConfig.cache.cache_key_mode);
    await ctx.get("cacheService").deleteCachedResponse(key);
    return ctx.json({ deleted: 1 });
  }

  if (typeof body["urlPrefix"] === "string") {
    let parsed: URL;
    try {
      parsed = new URL(body["urlPrefix"]);
    } catch {
      return ctx.json({ error: "Invalid 'urlPrefix'" }, 400);
    }

    const site = resolveSiteIdByHost(ctx, parsed.host, parsed.protocol);
    if (!site) {
      return ctx.json({ error: "No site matched by URL prefix hostname" }, 400);
    }

    const keyPrefix = makePageCacheKey(site, parsed.pathname, "", "path");
    const count = await ctx.get("cacheService").deleteByPrefix(keyPrefix);
    return ctx.json({ deleted: count });
  }

  return ctx.json({
    error:
      "Request body must contain one of: 'tag', ('site' + 'path'), ('site' + 'prefix'), 'url', or 'urlPrefix'",
  }, 400);
};

/**
 * POST /api/v1/list_cached_pages
 *
 * 请求体：
 * - `{"urlPrefix": "(https://)example.com/wiki/Category:"}` — 按 URL 前缀列出
 * - `{"tag": "wiki"}` — 按 tag 列出
 *
 * 请求必须包含有效的 API Key（通过 `x-api-key` 请求头提供）。
 */
export const listCachedPages = async (ctx: AppContext) => {
  const apiKey = ctx.req.header("x-api-key");
  if (typeof apiKey !== "string" || !timingSafeEqual(apiKey, ctx.get("appConfig").api.key)) {
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  const body = await parseJsonBody(ctx);

  if (typeof body["tag"] === "string") {
    const keys = await ctx.get("cacheService").listByTag(body["tag"]);
    return ctx.json({ keys });
  }

  if (typeof body["urlPrefix"] === "string") {
    let parsed: URL;
    try {
      parsed = new URL(body["urlPrefix"]);
    } catch {
      return ctx.json({ error: "Invalid 'urlPrefix'" }, 400);
    }

    const site = resolveSiteIdByHost(ctx, parsed.host, parsed.protocol);
    if (!site) {
      return ctx.json({ error: "No site matched by URL prefix hostname" }, 400);
    }

    const keyPrefix = makePageCacheKey(site, parsed.pathname, "", "path");
    const keys = await ctx.get("cacheService").listByPrefix(keyPrefix);
    return ctx.json({ keys });
  }

  return ctx.json({
    error: "Request body must contain 'tag' or 'urlPrefix'",
  }, 400);
};
