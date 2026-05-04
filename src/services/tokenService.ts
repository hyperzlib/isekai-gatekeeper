import type Koa from "koa";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto.ts";
import type { AppConfig } from "../types/config.ts";

const COOKIE_NAME = "isekai_pow";

/**
 * 签发 PoW Cookie。
 * 格式：<unix_ts>.<HMAC-SHA256(unix_ts, secret)>
 */
export async function issuePowCookie(ctx: Koa.Context): Promise<void> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSha256Hex(ts, ctx.appConfig.browser_challenge.secret);
  const value = `${ts}.${sig}`;
  ctx.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: ctx.appConfig.browser_challenge.cookie_ttl * 1000,
    overwrite: true,
  });
}

/**
 * 验证请求中的 PoW Cookie。
 * 检查签名 + 未过期（基于 cookie_ttl）。
 */
export async function validatePowCookie(
  ctx: Koa.Context,
): Promise<boolean> {
  const raw = ctx.cookies.get(COOKIE_NAME);
  if (!raw) return false;

  const dotIdx = raw.lastIndexOf(".");
  if (dotIdx === -1) return false;

  const ts = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);

  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - tsNum > ctx.appConfig.browser_challenge.cookie_ttl) return false;

  const expected = await hmacSha256Hex(ts, ctx.appConfig.browser_challenge.secret);
  return timingSafeEqual(expected, sig);
}
