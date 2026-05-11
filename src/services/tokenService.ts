import type Koa from "koa";
import { hmacSha256Hex, timingSafeEqual } from "../utils/crypto.ts";
import { randomUUID } from "crypto";

export const TOKEN_COOKIE_NAME = "isekai_gatekeeper_token";

/**
 * 签发验证通过 Cookie。
 * 格式：<unix_ts>.<HMAC-SHA256(unix_ts, secret)>
 */
export async function issueChallengePassCookie(ctx: Koa.Context, clientId?: string): Promise<void> {
  clientId ??= randomUUID();

  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSha256Hex(`${clientId}.${ts}`, ctx.appConfig.browser_challenge.secret);
  const value = `${clientId}.${ts}.${sig}`;
  ctx.cookies.set(TOKEN_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: ctx.appConfig.browser_challenge.cookie_ttl * 1000,
    overwrite: true,
  });
}

/**
 * 验证请求中的验证通过 Cookie。
 * 检查签名 + 未过期（基于 cookie_ttl）。
 * @returns 验证通过的 clientId，或 null（无效/过期）。
 */
export async function validateChallengePassCookie(
  ctx: Koa.Context,
): Promise<string | null> {
  const raw = ctx.cookies.get(TOKEN_COOKIE_NAME);
  if (!raw) return null;

  const dotIdx = raw.lastIndexOf(".");
  if (dotIdx === -1) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;

  const clientId = parts[0]!;
  const ts = parts[1]!;
  const sig = parts[2]!;

  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (now - tsNum > ctx.appConfig.browser_challenge.cookie_ttl) return null;

  const expected = await hmacSha256Hex(`${clientId}.${ts}`, ctx.appConfig.browser_challenge.secret);
  if (!timingSafeEqual(expected, sig)) {
    return null;
  }

  return clientId;
}

export function clearChallengePassCookie(ctx: Koa.Context): void {
  ctx.cookies.set(TOKEN_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    expires: new Date(0),
    overwrite: true,
  });
}