/**
 * Arkose Labs FunCaptcha provider 适配器。
 *
 * API: POST https://funcaptcha-api.arkoselabs.com/fc/vc
 * 请求体: application/x-www-form-urlencoded
 *  - private_key, session_token
 * 响应: { solved: boolean }
 */
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://funcaptcha-api.arkoselabs.com/fc/vc";
const TIMEOUT_MS = 5000;

export const funcaptchaAdapter: CaptchaProviderAdapter = {
  name: "funcaptcha",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.funcaptcha;
    if (!cfg.private_key) {
      throw new CaptchaError("FunCaptcha private_key is empty", CaptchaErrorKind.Config);
    }

    const body = new URLSearchParams();
    body.set("private_key", cfg.private_key);
    body.set("session_token", req.token);

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
          `FunCaptcha upstream HTTP ${res.status}`,
          CaptchaErrorKind.Network,
        );
      }

      const data = (await res.json()) as { solved: boolean };

      return {
        success: data.solved,
        errorCodes: data.solved ? undefined : ["not-solved"],
      };
    } catch (err) {
      if (err instanceof CaptchaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new CaptchaError("FunCaptcha request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `FunCaptcha network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
