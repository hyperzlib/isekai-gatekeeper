/**
 * hCaptcha provider 适配器。
 *
 * API: POST https://api.hcaptcha.com/siteverify
 * 请求体: application/x-www-form-urlencoded
 *  - secret, response, sitekey, remoteip (可选)
 * 响应: { success: boolean, "error-codes"?: string[] }
 */
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://api.hcaptcha.com/siteverify";
const TIMEOUT_MS = 5000;

export const hcaptchaAdapter: CaptchaProviderAdapter = {
  name: "hcaptcha",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.hcaptcha;
    if (!cfg.secret_key) {
      throw new CaptchaError("hCaptcha secret_key is empty", CaptchaErrorKind.Config);
    }

    const body = new URLSearchParams();
    body.set("secret", cfg.secret_key);
    body.set("response", req.token);
    body.set("sitekey", cfg.site_key);
    if (req.remoteIp) body.set("remoteip", req.remoteIp);

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
          `hCaptcha upstream HTTP ${res.status}`,
          CaptchaErrorKind.Network,
        );
      }

      const data = (await res.json()) as {
        success: boolean;
        "error-codes"?: string[];
      };

      return {
        success: data.success,
        errorCodes: data["error-codes"],
      };
    } catch (err) {
      if (err instanceof CaptchaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new CaptchaError("hCaptcha request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `hCaptcha network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
