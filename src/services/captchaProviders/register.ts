/**
 * 验证码提供商注册入口。
 * 在应用启动时 import 此文件即可完成所有 provider 的注册。
 */
import { recaptchaAdapter } from "./recaptcha.ts";
import { hcaptchaAdapter } from "./hcaptcha.ts";
import { geetestAdapter } from "./geetest.ts";
import { turnstileAdapter } from "./turnstile.ts";
import { funcaptchaAdapter } from "./funcaptcha.ts";
import { aliyunAdapter } from "./aliyun.ts";
import { tencentAdapter } from "./tencent.ts";

export const captchaProviders = [
  recaptchaAdapter,
  hcaptchaAdapter,
  geetestAdapter,
  turnstileAdapter,
  funcaptchaAdapter,
  aliyunAdapter,
  tencentAdapter
];
