/**
 * Google reCAPTCHA v2/v3 provider 适配器。
 *
 * API: POST https://www.google.com/recaptcha/api/siteverify
 * 请求体: application/x-www-form-urlencoded
 *  - secret, response, remoteip (可选)
 * 响应: { success: boolean, "error-codes"?: string[] }
 */
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const TIMEOUT_MS = 5000;

const getVerifyUrl = (config: CaptchaConfig): string => {
    const cfg = config.recaptcha;
    const api_domain = cfg.api_domain ?? "www.google.com";
    return `https://${api_domain}/recaptcha/api/siteverify`;
  }

export const recaptchaAdapter: CaptchaProviderAdapter = {
  name: "recaptcha",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.recaptcha;
    if (!cfg.secret_key) {
      throw new CaptchaError("reCAPTCHA secret_key is empty", CaptchaErrorKind.Config);
    }

    const body = new URLSearchParams();
    body.set("secret", cfg.secret_key);
    body.set("response", req.token);
    if (req.remoteIp) body.set("remoteip", req.remoteIp);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(getVerifyUrl(config), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new CaptchaError(
          `reCAPTCHA upstream HTTP ${res.status}`,
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
        throw new CaptchaError("reCAPTCHA request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `reCAPTCHA network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
