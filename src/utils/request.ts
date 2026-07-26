import type { AppContext } from "../types/hono";

export function getRequestHost(ctx: AppContext): string {
  return ctx.req.header("host") ?? new URL(ctx.req.url).host;
}

export function getRequestProtocol(ctx: AppContext): string {
  const forwarded = ctx.req.header("x-forwarded-proto")?.replace(/:$/, "");
  if (forwarded) return forwarded;
  return new URL(ctx.req.url).protocol.replace(/:$/, "");
}

export function getRequestIp(ctx: AppContext): string {
  const forwarded = ctx.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const connecting = ctx.req.header("cf-connecting-ip") ?? ctx.req.header("x-real-ip");
  if (connecting) return connecting.trim();
  return "unknown";
}

