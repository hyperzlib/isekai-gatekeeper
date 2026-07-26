import type { MiddlewareHandler } from "hono";
import { CHALLENGE_PATH_PREFIX } from "../routes/challengeRoutes";
import type { AppEnv } from "../types/hono.ts";

export const reverseProxyMiddleware: MiddlewareHandler<AppEnv> = async (ctx, next) => {
  // 挑战路由直接透传（由 challengeRoutes 处理）
  if (ctx.req.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    await next();
    return;
  }

  const site = ctx.get("currentSite");
  const decision = ctx.get("decision");
  if (!site || !decision) {
    return ctx.text("Site configuration or decision missing", 500);
  }

  if (ctx.get("appConfig").cache.bypass_after_challenge && ctx.get("validatedClientId")) {
    decision.cache = { enabled: false };
  }

  return ctx.get("proxyService").forward(ctx, site, decision);
};
