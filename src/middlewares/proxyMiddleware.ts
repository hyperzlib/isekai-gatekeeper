import Koa from "koa";
import { CHALLENGE_PATH_PREFIX } from "../routes/challengeRoutes";

export const reverseProxyMiddleware: Koa.Middleware = async (ctx, next) => {
  // 挑战路径直接透传（由 challengeRoutes 处理）
  if (ctx.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    return next();
  }

  if (!ctx.currentSite || !ctx.decision) {
    ctx.status = 500;
    ctx.body = "Site configuration or decision missing";
    return;
  }

  const site = ctx.currentSite;
  const decision = ctx.decision;
  
  await ctx.proxyService.forward(ctx, site, decision);
};