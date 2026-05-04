import Koa from "koa";

/**
 * IP 中间件
 */
export const ipMiddleware: Koa.Middleware = async (ctx, next) => {
  if (ctx.geoipService) {
    ctx.geoip = ctx.geoipService.lookup(ctx.ip) ?? undefined;
  }
  await next();
}