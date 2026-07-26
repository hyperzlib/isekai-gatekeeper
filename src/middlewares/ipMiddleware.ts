import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/hono.ts";
import { getRequestIp } from "../utils/request.ts";

/**
 * IP 中间件
 */
export const ipMiddleware: MiddlewareHandler<AppEnv> = async (ctx, next) => {
  const ip = getRequestIp(ctx);
  ctx.set("requestIp", ip);
  ctx.set("geoip", ctx.get("geoipService").lookup(ip) ?? undefined);
  await next();
};
