import type Koa from "koa";
import { generateChallenge, verifyChallengeToken, verifyPow } from "../services/challengeService.ts";
import { issuePowCookie } from "../services/tokenService.ts";
import { CaptchaError, CaptchaErrorKind } from "../services/captchaService.ts";
import type { CaptchaConfig, CaptchaPublicConfig } from "../types/config.ts";

/**
 * 从验证码配置提取仅前端必需的公开字段
 */
export function getCaptchaPublicConfig(captcha: CaptchaConfig | undefined): CaptchaPublicConfig {
  if (!captcha?.type) return { provider: null };
  const provider = captcha[captcha.type];

  const base: CaptchaPublicConfig = { provider: captcha.type };
  switch (captcha.type) {
    case "recaptcha":
    case "hcaptcha":
    case "turnstile":
      base.siteKey = (provider as { site_key: string }).site_key;
      break;
    case "geetest":
      base.gtId = (provider as { id: string }).id;
      break;
    case "funcaptcha":
      base.publicKey = (provider as { public_key: string }).public_key;
      break;
    case "tencent":
      base.appId = (provider as { secret_id: string }).secret_id;
      break;
    case "aliyun":
      // aliyun 前端不需要额外公钥（通过 scene 初始化）
      break;
  }
  return base;
}

/**
 * GET /.isekai-gatekeeper/challenge
 * 返回 PoW 挑战 JSON。
 */
export const getChallenge = async (ctx: Koa.Context) => {
  const payload = await generateChallenge(ctx.appConfig.browser_challenge);
  ctx.body = payload;
};

export const verifyPowChallenge = async (ctx: Koa.Context, body: Record<string, unknown>) => {
  

  const challenge = body["challenge"];
  const nonce = body["nonce"];
  const token = body["token"];
  const expires = body["expires"];

  if (
    typeof challenge !== "string" ||
    typeof nonce !== "number" ||
    typeof token !== "string" ||
    typeof expires !== "number"
  ) {
    ctx.status = 400;
    ctx.body = { error: "Invalid request body" };
    return;
  }

  // 验证 token 合法性（防伪造挑战）
  const tokenValid = await verifyChallengeToken(
    challenge,
    expires,
    token,
    ctx.appConfig.browser_challenge.secret,
  );
  if (!tokenValid) {
    ctx.status = 403;
    ctx.body = { error: "Invalid or expired challenge token" };
    return;
  }

  // 验证 PoW
  const powValid = await verifyPow(challenge, nonce, ctx.appConfig.browser_challenge.pow.difficulty);
  if (!powValid) {
    ctx.status = 403;
    ctx.body = { error: "Proof-of-work verification failed" };
    return;
  }

  await issuePowCookie(ctx);
  ctx.body = { success: true };
}

export const verifyCaptchaChallenge = async (ctx: Koa.Context, body: Record<string, unknown>) => {
  const token = body["captcha_token"];
  if (typeof token !== "string") {
    ctx.status = 400;
    ctx.body = { error: "Invalid request body" };
    return;
  }

  const extra: Record<string, string> = {};
  if (typeof body["extra"] === "object" && body["extra"] !== null) {
    for (const [k, v] of Object.entries(body["extra"] as Record<string, unknown>)) {
      if (typeof v === "string") extra[k] = v;
    }
  }

  try {
    const result = await ctx.captchaService.verify({
      token,
      remoteIp: ctx.ip,
      extra,
    });

    if (!result.success) {
      ctx.status = 403;
      ctx.body = { error: "Captcha verification failed" };
      return;
    }

    await issuePowCookie(ctx);
    ctx.body = { success: true };
  } catch (err) {
    if (err instanceof CaptchaError) {
      if (err.kind === CaptchaErrorKind.Config) {
        console.error("[captcha] Config error:", err.message);
        ctx.status = 500;
        ctx.body = { error: "Captcha service misconfigured" };
      } else if (err.kind === CaptchaErrorKind.Network) {
        console.error("[captcha] Network error:", err.message);
        ctx.status = 502;
        ctx.body = { error: "Captcha service unavailable" };
      } else {
        ctx.status = 403;
        ctx.body = { error: err.message };
      }
    } else {
      console.error("[captcha] Unexpected error:", err);
      ctx.status = 500;
      ctx.body = { error: "Internal error" };
    }
  }
};

/**
 * POST /.isekai-gatekeeper/verify
 * 验证 PoW 或验证码，成功则签发 Cookie。
 */
export const verifyChallenge = async (ctx: Koa.Context) => {
  const body = ctx.request.body as Record<string, unknown>;

  switch (body["type"]) {
    case "pow":
      await verifyPowChallenge(ctx, body);
      break;
    case "captcha":
      await verifyCaptchaChallenge(ctx, body);
      break;
    default:
      ctx.status = 400;
      ctx.body = { error: "Invalid challenge type" };
      break;
  }
};

/**
 * GET /.isekai-gatekeeper/
 * 渲染挑战页面（Handlebars 模板）。
 */
export const renderChallengePage = (ctx: Koa.Context) => {
  const redirect = (ctx.query["redirect"] as string | undefined) ?? "/";
  const publicCfg = getCaptchaPublicConfig(ctx.appConfig.captcha);

  ctx.status = 403;
  const template = ctx.tpl.create("challenge");
  template.assignAll({
    captchaProvider: publicCfg.provider ?? "",
    captchaSiteKey: publicCfg.siteKey ?? "",
    captchaGtId: publicCfg.gtId ?? "",
    captchaPublicKey: publicCfg.publicKey ?? "",
    captchaAppId: publicCfg.appId ?? "",
    redirect,
    challengeApiPath: "/.isekai-gatekeeper/challenge",
    verifyApiPath: "/.isekai-gatekeeper/verify",
  });
  template.flush(ctx);
};