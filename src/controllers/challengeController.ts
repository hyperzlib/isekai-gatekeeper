import { generateChallenge, verifyChallengeToken, verifyPow } from "../services/challengeService.ts";
import { issueChallengePassCookie } from "../services/tokenService.ts";
import { CaptchaError, CaptchaErrorKind } from "../services/captchaService.ts";
import type { CaptchaConfig, FunCaptchaProviderConfig, GeeTestProviderConfig, RecaptchaProviderConfig, TencentProviderConfig } from "../types/config.ts";
import { CHALLENGE_PATH_PREFIX } from "../routes/challengeRoutes.ts";
import type { AppContext } from "../types/hono.ts";
import { getRequestIp } from "../utils/request.ts";

/**
 * 从验证码配置提取仅前端必需的公开字段
 */
export function getCaptchaPublicConfig(captcha: CaptchaConfig | undefined): Record<string, any> {
  if (!captcha?.type) return { provider: null };
  const provider = captcha[captcha.type];

  const base: Record<string, any> = {
    captchaProvider: captcha.type
  };

  switch (captcha.type) {
    case "recaptcha":
      const recaptchaProvider = provider as RecaptchaProviderConfig;
      base.siteKey = recaptchaProvider.site_key;
      base.jsDomain = recaptchaProvider.js_domain ?? "google.com";
      break;
    case "hcaptcha":
    case "turnstile":
      base.siteKey = (provider as { site_key: string }).site_key;
      break;
    case "geetest":
      base.gtId = (provider as GeeTestProviderConfig).id;
      break;
    case "funcaptcha":
      base.publicKey = (provider as FunCaptchaProviderConfig).public_key;
      break;
    case "tencent":
      base.appId = (provider as TencentProviderConfig).secret_id;
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
export const getChallenge = async (ctx: AppContext) => {
  const payload = await generateChallenge(ctx.get("appConfig").browser_challenge);
  return ctx.json(payload);
};

export const verifyPowChallenge = async (ctx: AppContext, body: Record<string, unknown>) => {
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
    return ctx.json({ error: "Invalid request body" }, 400);
  }

  // 验证 token 合法性（防伪造挑战）
  const appConfig = ctx.get("appConfig");
  const tokenValid = await verifyChallengeToken(
    challenge,
    expires,
    token,
    appConfig.browser_challenge.secret,
  );
  if (!tokenValid) {
    return ctx.json({ error: "Invalid or expired challenge token" }, 403);
  }

  // 验证 PoW
  const powValid = await verifyPow(challenge, nonce, appConfig.browser_challenge.pow.difficulty);
  if (!powValid) {
    return ctx.json({ error: "Proof-of-work verification failed" }, 403);
  }

  await issueChallengePassCookie(ctx);
  return ctx.json({ success: true });
}

export const verifyCaptchaChallenge = async (ctx: AppContext, body: Record<string, unknown>) => {
  const token = body["captcha_token"];
  if (typeof token !== "string") {
    return ctx.json({ error: "Invalid request body" }, 400);
  }

  const extra: Record<string, string> = {};
  if (typeof body["extra"] === "object" && body["extra"] !== null) {
    for (const [k, v] of Object.entries(body["extra"] as Record<string, unknown>)) {
      if (typeof v === "string") extra[k] = v;
    }
  }

  try {
    const result = await ctx.get("captchaService").verify({
      token,
      remoteIp: getRequestIp(ctx),
      extra,
    });

    if (!result.success) {
      return ctx.json({ error: "Captcha verification failed" }, 403);
    }

    await issueChallengePassCookie(ctx);
    return ctx.json({ success: true });
  } catch (err) {
    if (err instanceof CaptchaError) {
      if (err.kind === CaptchaErrorKind.Config) {
        console.error("[captcha] Config error:", err.message);
        return ctx.json({ error: "Captcha service misconfigured" }, 500);
      } else if (err.kind === CaptchaErrorKind.Network) {
        console.error("[captcha] Network error:", err.message);
        return ctx.json({ error: "Captcha service unavailable" }, 502);
      } else {
        return ctx.json({ error: err.message }, 403);
      }
    } else {
      console.error("[captcha] Unexpected error:", err);
      return ctx.json({ error: "Internal error" }, 500);
    }
  }
};

/**
 * POST /.isekai-gatekeeper/verify
 * 验证 PoW 或验证码，成功则签发 Cookie。
 */
export const verifyChallenge = async (ctx: AppContext) => {
  let body: Record<string, unknown>;
  try {
    body = await ctx.req.json();
  } catch {
    return ctx.json({ error: "Invalid request body" }, 400);
  }

  switch (body["type"]) {
    case "pow":
      return verifyPowChallenge(ctx, body);
    case "captcha":
      return verifyCaptchaChallenge(ctx, body);
    default:
      return ctx.json({ error: "Invalid challenge type" }, 400);
  }
};

/**
 * GET /.isekai-gatekeeper/
 * 渲染挑战页面（Handlebars 模板）。
 */
export const renderChallengePage = (ctx: AppContext) => {
  let redirect = ctx.req.query("redirect") ?? ".";

  if (redirect === "." && ctx.req.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    // 如果没有指定 redirect，且当前路径是挑战相关路径，则默认重定向到根路径，避免重定向回挑战页面导致死循环。
    redirect = "/";
  }

  const publicCfg = getCaptchaPublicConfig(ctx.get("appConfig").captcha);

  const template = ctx.get("tpl").create("challenge");

  template.assign('challengeConfig', {
    challengeApi: "/.isekai-gatekeeper/challenge",
    verifyApi: "/.isekai-gatekeeper/verify",
    ...publicCfg,
    redirect,
  });
  
  if (publicCfg.captchaProvider) {
    template.assign('enableCaptcha', true);
  }

  return template.toResponse(403);
};
