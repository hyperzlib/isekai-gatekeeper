/**
 * 阿里云 Captcha2（行为验证码）provider 适配器。
 *
 * API: 阿里云 OpenAPI — HTTPS 签名请求
 * 请求方式: GET / POST (query string 签名)
 * Action: VerifyIntelligentCaptcha
 * 签名算法: HMAC-SHA1
 * 响应: { Code: "OK"|..., Data: { VerifyResult: boolean } }
 */
import { createHmac, createHash } from "node:crypto";
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://captcha.cn-shanghai.aliyuncs.com/";
const TIMEOUT_MS = 5000;

function sha1Hex(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

function hmacSha1(key: string, data: string): string {
  return createHmac("sha1", key).update(data).digest("base64");
}

function hmacSha1Hex(key: string, data: string): string {
  return createHmac("sha1", key).update(data).digest("hex");
}

/** 阿里云 POP 签名 */
function sign(key: string, stringToSign: string): string {
  return hmacSha1(`${key}&`, stringToSign);
}

export const aliyunAdapter: CaptchaProviderAdapter = {
  name: "aliyun",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.aliyun;
    if (!cfg.access_key_id || !cfg.access_key_secret) {
      throw new CaptchaError(
        "Aliyun access_key_id or access_key_secret is empty",
        CaptchaErrorKind.Config,
      );
    }

    const sceneId = req.extra?.scene_id ?? "";
    const captchaVerifyParam = req.token; // 前端回调的 captchaVerifyParam

    const params: Record<string, string> = {
      Action: "VerifyIntelligentCaptcha",
      Format: "JSON",
      Version: "2023-03-05",
      AccessKeyId: cfg.access_key_id,
      SignatureMethod: "HMAC-SHA1",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      SignatureVersion: "1.0",
      SignatureNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      CaptchaVerifyParam: captchaVerifyParam,
      SceneId: sceneId,
    };

    // 构造签名
    const sortedKeys = Object.keys(params).sort();
    const queryString = sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join("&");
    const stringToSign = `POST&${encodeURIComponent("/")}&${encodeURIComponent(queryString)}`;
    const signature = sign(cfg.access_key_secret, stringToSign);
    params.Signature = signature;

    const body = new URLSearchParams(params);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new CaptchaError(
          `Aliyun upstream HTTP ${res.status}`,
          CaptchaErrorKind.Network,
        );
      }

      const data = (await res.json()) as {
        Code: string;
        Message?: string;
        Data?: { VerifyResult?: boolean };
      };

      if (data.Code !== "OK" && data.Code !== "Success") {
        throw new CaptchaError(
          `Aliyun API error: ${data.Code} ${data.Message ?? ""}`,
          CaptchaErrorKind.Network,
        );
      }

      const success = data.Data?.VerifyResult === true;
      return {
        success,
        errorCodes: success ? undefined : [data.Code ?? "aliyun-fail"],
      };
    } catch (err) {
      if (err instanceof CaptchaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new CaptchaError("Aliyun request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `Aliyun network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
