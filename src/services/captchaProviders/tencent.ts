/**
 * 腾讯云 TCaptcha provider 适配器。
 *
 * API: 腾讯云 API 3.0 — TC3-HMAC-SHA256 签名
 * 请求方式: POST https://captcha.tencentcloudapi.com/
 * Action: DescribeCaptchaResult
 * 请求头: Authorization, Content-Type, Host, X-TC-Action, X-TC-Timestamp, X-TC-Version
 * 响应: { Response: { CaptchaCode: number, CaptchaMsg: string } }
 *   CaptchaCode === 1 表示通过
 */
import { createHmac, createHash } from "node:crypto";
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://captcha.tencentcloudapi.com/";
const TIMEOUT_MS = 5000;
const SERVICE = "captcha";
const VERSION = "2019-07-22";
const ACTION = "DescribeCaptchaResult";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export const tencentAdapter: CaptchaProviderAdapter = {
  name: "tencent",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.tencent;
    if (!cfg.secret_id || !cfg.secret_key) {
      throw new CaptchaError(
        "Tencent secret_id or secret_key is empty",
        CaptchaErrorKind.Config,
      );
    }

    const captchaAppId = req.extra?.captcha_app_id ?? "";
    const randstr = req.extra?.randstr ?? "";

    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

    const payload = JSON.stringify({
      CaptchaType: 9,       // V2 验证码
      Ticket: req.token,    // 验证码回调 ticket
      UserIp: req.remoteIp ?? "0.0.0.0",
      Randstr: randstr,
      CaptchaAppId: Number(captchaAppId) || 0,
      AppSecretKey: cfg.secret_key,
    });

    // TC3-HMAC-SHA256 签名
    const httpRequestMethod = "POST";
    const canonicalUri = "/";
    const canonicalQueryString = "";
    const canonicalHeaders = `content-type:application/json\nhost:${new URL(VERIFY_URL).host}\n`;
    const signedHeaders = "content-type;host";
    const hashedPayload = sha256Hex(payload);

    const canonicalRequest = [
      httpRequestMethod,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      hashedPayload,
    ].join("\n");

    const algorithm = "TC3-HMAC-SHA256";
    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const hashedCanonicalRequest = sha256Hex(canonicalRequest);
    const stringToSign = [
      algorithm,
      timestamp.toString(),
      credentialScope,
      hashedCanonicalRequest,
    ].join("\n");

    const secretDate = hmacSha256(`TC3${cfg.secret_key}`, date);
    const secretService = hmacSha256(secretDate, SERVICE);
    const secretSigning = hmacSha256(secretService, "tc3_request");
    const signature = hmacSha256Hex(secretSigning, stringToSign);

    const authorization = `${algorithm} Credential=${cfg.secret_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(VERIFY_URL, {
        method: "POST",
        headers: {
          "Authorization": authorization,
          "Content-Type": "application/json",
          "Host": new URL(VERIFY_URL).host,
          "X-TC-Action": ACTION,
          "X-TC-Timestamp": timestamp.toString(),
          "X-TC-Version": VERSION,
        },
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new CaptchaError(
          `Tencent upstream HTTP ${res.status}`,
          CaptchaErrorKind.Network,
        );
      }

      const data = (await res.json()) as {
        Response?: {
          CaptchaCode?: number;
          CaptchaMsg?: string;
          Error?: { Code: string; Message: string };
        };
      };

      if (data.Response?.Error) {
        throw new CaptchaError(
          `Tencent API error: ${data.Response.Error.Code} ${data.Response.Error.Message}`,
          CaptchaErrorKind.Network,
        );
      }

      // CaptchaCode: 1 恶意请求被拦截, 0 正常通过
      const captchaCode = data.Response?.CaptchaCode ?? -1;
      const success = captchaCode === 0;

      return {
        success,
        errorCodes: success ? undefined : [`code=${captchaCode}`],
      };
    } catch (err) {
      if (err instanceof CaptchaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new CaptchaError("Tencent request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `Tencent network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
