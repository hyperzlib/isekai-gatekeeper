import type { AppConfig, CaptchaConfig, CaptchaProvider } from "../types/config.ts";
import { captchaProviders } from "./captchaProviders/register.ts";

// ── 错误分类 ─────────────────────────────────────────────────────────────────

export enum CaptchaErrorKind {
  /** 配置缺失或凭据为空 */
  Config = "config",
  /** 上游网络错误或超时 */
  Network = "network",
  /** 验证失败（token 无效或已过期） */
  Verification = "verification",
}

export class CaptchaError extends Error {
  constructor(
    message: string,
    public readonly kind: CaptchaErrorKind,
  ) {
    super(message);
    this.name = "CaptchaError";
  }
}

// ── 统一接口 ─────────────────────────────────────────────────────────────────

export interface CaptchaVerifyRequest {
  /** 前端提交的一次性 token / ticket / randstr 等 */
  token: string;
  /** 客户端 IP（部分提供商如 hCaptcha 需要） */
  remoteIp?: string;
  /** 额外参数（如 geetest challenge/seccode） */
  extra?: Record<string, string>;
}

export interface CaptchaVerifyResult {
  /** 是否通过 */
  success: boolean;
  /** 提供商返回的错误码列表（便于日志） */
  errorCodes?: string[];
}

/**
 * 验证码提供商适配器接口。
 * 每个 provider 实现此接口，由 captchaService 注册表按名称调度。
 */
export interface CaptchaProviderAdapter {
  readonly name: CaptchaProvider;
  /**
   * 向后端校验服务发送验证请求。
   * 成功返回 { success: true }，失败返回 { success: false, errorCodes }。
   * 配置 / 网络异常抛出 CaptchaError。
   */
  verify(config: CaptchaConfig, req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult>;
}

export class CaptchaService {
  private config?: CaptchaConfig;
  private providerMap = new Map<CaptchaProvider, CaptchaProviderAdapter>();

  constructor(appConfig: AppConfig) {
    this.config = appConfig.captcha;

    for (const provider of captchaProviders) {
      this.registerProvider(provider);
    }
  }

  public registerProvider(adapter: CaptchaProviderAdapter): void {
    this.providerMap.set(adapter.name, adapter);
  }

  public getProvider(name: CaptchaProvider): CaptchaProviderAdapter | undefined {
    return this.providerMap.get(name);
  }

  public async verify(req: CaptchaVerifyRequest): Promise<CaptchaVerifyResult> {
    if (!this.config?.type) {
      throw new CaptchaError("Captcha not configured", CaptchaErrorKind.Config);
    }

    const provider = this.getProvider(this.config.type);
    if (!provider) {
      throw new CaptchaError(
        `Unknown captcha provider: ${this.config.type}`,
        CaptchaErrorKind.Config,
      );
    }

    return provider.verify(this.config, req);
  }
}