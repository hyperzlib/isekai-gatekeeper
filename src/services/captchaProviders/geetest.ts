/**
 * GeeTest v4 (极验) provider 适配器。
 *
 * API: POST https://gcaptcha4.geetest.com/validate
 * 请求体: application/x-www-form-urlencoded
 *  - lot_number, captcha_output, pass_token, gen_time
 *  - captcha_id, sign_token
 * sign_token = HMAC-SHA256(lot_number, key)
 * 响应: { status: "success"|"fail", code: string, msg: string }
 */
import { createHmac } from "node:crypto";
import type { CaptchaConfig } from "../../types/config.ts";
import type { CaptchaProviderAdapter, CaptchaVerifyRequest, CaptchaVerifyResult } from "../captchaService.ts";
import { CaptchaError, CaptchaErrorKind } from "../captchaService.ts";

const VERIFY_URL = "https://gcaptcha4.geetest.com/validate";
const TIMEOUT_MS = 5000;

function computeSignToken(lotNumber: string, key: string): string {
  return createHmac("sha256", key).update(lotNumber).digest("hex");
}

export const geetestAdapter: CaptchaProviderAdapter = {
  name: "geetest",

  async verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    const cfg = config.geetest;
    if (!cfg.id || !cfg.key) {
      throw new CaptchaError("GeeTest id or key is empty", CaptchaErrorKind.Config);
    }

    const lotNumber = req.extra?.lot_number ?? "";
    const captchaOutput = req.extra?.captcha_output ?? "";
    const passToken = req.extra?.pass_token ?? "";
    const genTime = req.extra?.gen_time ?? "";

    if (!lotNumber || !captchaOutput || !passToken || !genTime) {
      throw new CaptchaError(
        "GeeTest missing required fields: lot_number, captcha_output, pass_token, gen_time",
        CaptchaErrorKind.Verification,
      );
    }

    const signToken = computeSignToken(lotNumber, cfg.key);

    const body = new URLSearchParams();
    body.set("lot_number", lotNumber);
    body.set("captcha_output", captchaOutput);
    body.set("pass_token", passToken);
    body.set("gen_time", genTime);
    body.set("captcha_id", cfg.id);
    body.set("sign_token", signToken);

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
          `GeeTest upstream HTTP ${res.status}`,
          CaptchaErrorKind.Network,
        );
      }

      const data = (await res.json()) as {
        status: string;
        code: string;
        msg: string;
      };

      const success = data.status === "success";
      return {
        success,
        errorCodes: success ? undefined : [data.code ?? "geetest-fail"],
      };
    } catch (err) {
      if (err instanceof CaptchaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new CaptchaError("GeeTest request timed out", CaptchaErrorKind.Network);
      }
      throw new CaptchaError(
        `GeeTest network error: ${(err as Error).message}`,
        CaptchaErrorKind.Network,
      );
    }
  },
};
