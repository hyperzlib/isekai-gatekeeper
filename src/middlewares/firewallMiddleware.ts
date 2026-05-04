import type Koa from "koa";
import { validatePowCookie } from "../services/tokenService.ts";
import type { Decision, RequestContext } from "../types/decision.ts";
import { renderChallengePage } from "../controllers/challengeController.ts";
import { buildCacheKey } from "../services/ruleEngineService.ts";

const CHALLENGE_PATH_PREFIX = "/.isekai-gatekeeper";

/**
 * 从 Koa Context 构建规则引擎所需的 RequestContext。
 */
function buildRequestContext(ctx: Koa.Context): RequestContext {
  const url = new URL(ctx.url, `http://${ctx.host}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const cookies: Record<string, string> = {};
  // 解析 Cookie 头
  const rawCookie = ctx.headers["cookie"] ?? "";
  for (const part of rawCookie.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    cookies[name] = value;
  }

  return {
    http: {
      request: {
        uri: {
          path: url.pathname,
          query: url.search.slice(1),
        },
        origin: ctx.headers["origin"] ?? `${ctx.protocol}://${ctx.host}`,
        headers,
        cookies,
        method: ctx.method,
      },
    },
  };
}

/**
 * 主防火墙中间件，按规则决策链路处理请求。
 */
export const firewallMiddleware: Koa.Middleware = async (ctx, next) => {
  // 挑战路径直接透传（由 challengeRoutes 处理）
  if (ctx.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    return next();
  }

  const site = ctx.proxyService.selectSite(ctx);
  if (!site) {
    ctx.status = 404;
    ctx.body = "Site not found";
    return;
  }

  const decision: Decision = ctx.ruleEngine?.evaluate(ctx) ?? {
    allow: false,
    cachePolicy: ctx.appConfig.cache,
    browserChallengePolicy: ctx.appConfig.browser_challenge,
    cacheKey: buildCacheKey(ctx, ctx.appConfig.cache.cacheKeyMode),
  };

  // [4] allow=true → 直接代理
  if (decision.allow) {
    await ctx.proxyService.forward(ctx, site, decision);
    return;
  }
  
  // 有效 PoW Cookie → 直接放行到代理（跳过挑战）
  const hasPowCookie = await validatePowCookie(ctx);

  // [5] 浏览器挑战
  if (decision.browserChallengePolicy.enabled && !hasPowCookie) {
    // 显示挑战页面
    renderChallengePage(ctx);
    return;
  }

  // [6] 缓存路径
  if (decision.cachePolicy.enabled) {
    const cached = ctx.cacheService.get(decision.cacheKey);
    if (cached) {
      ctx.status = cached.status;
      for (const [k, v] of Object.entries(cached.headers)) {
        // 跳过 transfer-encoding（body 已缓冲，不再分块）
        if (k.toLowerCase() === "transfer-encoding") continue;
        ctx.set(k, v);
      }
      ctx.set("X-Cache", "HIT");
      ctx.body = Buffer.from(cached.body);
      return;
    }

    // 缓存未命中 → 代理并写缓存
    ctx.set("X-Cache", "MISS");
    await ctx.proxyService.forward(ctx, site, decision);
    return;
  }

  // 有 PoW Cookie 或 challenge 未启用 → 代理
  await ctx.proxyService.forward(ctx, site, decision);
};