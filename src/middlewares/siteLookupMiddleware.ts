import type Koa from "koa";
import { Decision } from "../types/decision";
import { makePageCacheKey } from "../utils/cache";
import { validateChallengePassCookie } from "../services/tokenService";

export const siteLookupMiddleware: Koa.Middleware = async (ctx, next) => {
  const site = ctx.proxyService.selectSite(ctx);
  if (!site) {
    ctx.status = 404;
    ctx.body = "Site not found";
    return;
  }
  ctx.currentSiteId = site.id;
  ctx.currentSite = site.config;

  const validatedClientId = await validateChallengePassCookie(ctx);
  ctx.validatedClientId = validatedClientId;

  const decision: Decision = await ctx.ruleEngine?.evaluate(ctx) ?? {
    cache: ctx.appConfig.cache,
    browser_challenge: ctx.appConfig.browser_challenge,
    cache_key: makePageCacheKey(ctx.currentSiteId, ctx.URL.pathname, ctx.URL.search, ctx.appConfig.cache.cache_key_mode),
  };
  ctx.decision = decision;

  return next();
};