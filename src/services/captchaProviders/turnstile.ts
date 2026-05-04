/**
 * Cloudflare Turnstile provider 适配器。
 *
 * API: POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 * 请求体: application/json
 *  - secret, response, remoteip (可选)
 * 响应: { success: boolean, "error-codes"?: string[] }
 */
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

export const turnstileAdapter: CaptchaProviderAdapter = {
  name: "turnstile",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.turnstile;
    if (!cfg.secret_key) {
      throw new CaptchaError("Turnstile secret_key is empty", CaptchaErrorKind.Config);
    }

    const body: Record<string, string> = {
      secret: cfg.secret_key,
      response: req.token,
    };
    if (req.remoteIp) body.remoteip = req.remoteIp;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new CaptchaError(
          `Turnstile upstream HTTP ${res.status}`,
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
        throw new CaptchaError("Turnstile request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `Turnstile network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
