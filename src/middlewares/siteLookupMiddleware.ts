import type { MiddlewareHandler } from "hono";
import { makePageCacheKey } from "../utils/cache";
import { validateChallengePassCookie } from "../services/tokenService";
import type { Decision } from "../types/decision";
import type { AppEnv } from "../types/hono.ts";

export const siteLookupMiddleware: MiddlewareHandler<AppEnv> = async (ctx, next) => {
  const site = ctx.get("siteResolver").resolve(ctx);
  if (!site) {
    return ctx.text("Site not found", 404);
  }

  ctx.set("currentSiteId", site.id);
  ctx.set("currentSite", site.config);
  ctx.set("currentSiteMatchedHost", site.matchedHost);

  const validatedClientId = await validateChallengePassCookie(ctx);
  ctx.set("validatedClientId", validatedClientId);

  const appConfig = ctx.get("appConfig");
  const url = new URL(ctx.req.url);
  const decision: Decision = await ctx.get("ruleEngine")?.evaluate(ctx) ?? {
    cache: appConfig.cache,
    browser_challenge: appConfig.browser_challenge,
    cache_key: makePageCacheKey(site.id, url.pathname, url.search, appConfig.cache.cache_key_mode),
  };
  ctx.set("decision", decision);

  await next();
};
