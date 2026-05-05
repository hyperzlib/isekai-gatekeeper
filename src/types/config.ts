import { RuleConfig } from "./rule";

/** 站点后端配置 */
export interface BackendConfig {
  url: string;
  hostname?: string;
  headers?: Record<string, HandlebarsTemplateDelegate<any>>;
}

/** 站点配置 */
export interface SiteConfig {
  /** 对外 hostname（用于匹配 Host 请求头） */
  hostname: string;
  backend: BackendConfig;
  rules?: RuleConfig[];
}

/** 浏览器挑战配置 */
export interface BrowserChallengeConfig {
  enabled: boolean;
  tpl?: string;
  cookie_ttl: number;
  challenge_ttl: number;
  secret: string;
  pow: {
    difficulty: number;
  };
}

/** Bun redis 配置 */
export interface BunRedisConfig {
  url: string;
}

/** 全局缓存配置 */
export interface CacheConfig {
  enabled: boolean;
  provider: "memory" | "bunRedis";
  bun_redis?: BunRedisConfig;

  default_ttl: number;
  cache_key_mode: "path+query" | "path";
  max_entries: number;
  max_body_bytes: number;
  allowed_mimetypes: string[];
}

//#region 验证码配置
export type CaptchaProvider =
  | "recaptcha"
  | "hcaptcha"
  | "geetest"
  | "turnstile"
  | "funcaptcha"
  | "aliyun"
  | "tencent";

export interface RecaptchaProviderConfig {
  site_key: string;
  secret_key: string;
  api_domain?: string; // 可选，默认为 google.com，可以更改为 recaptcha.net 以支持中国大陆访问
  js_domain?: string; // 可选，默认为 google.com，可以更改为 recaptcha.net 以支持中国大陆访问
}

export interface HCaptchaProviderConfig {
  site_key: string;
  secret_key: string;
}

export interface GeeTestProviderConfig {
  id: string;
  key: string;
}

export interface TurnstileProviderConfig {
  site_key: string;
  secret_key: string;
}

export interface FunCaptchaProviderConfig {
  public_key: string;
  private_key: string;
}

export interface AliyunProviderConfig {
  access_key_id: string;
  access_key_secret: string;
}

export interface TencentProviderConfig {
  secret_id: string;
  secret_key: string;
}

export interface CaptchaConfig {
  enabled?: boolean;
  type?: CaptchaProvider;
  recaptcha: RecaptchaProviderConfig;
  hcaptcha: HCaptchaProviderConfig;
  geetest: GeeTestProviderConfig;
  turnstile: TurnstileProviderConfig;
  funcaptcha: FunCaptchaProviderConfig;
  aliyun: AliyunProviderConfig;
  tencent: TencentProviderConfig;
}

/** 暴露给挑战页面的验证码公开配置（不含 secret） */
export interface CaptchaPublicConfig {
  provider: CaptchaProvider | null;
  siteKey?: string;       // recaptcha / hcaptcha / turnstile
  gtId?: string;           // geetest id
  publicKey?: string;      // funcaptcha public_key
  appId?: string;          // tencent secret_id
}
//#endregion

/** GeoIP 配置 */
export interface GeoIPConfig {
  enabled: boolean;
  db_country_path?: string;
  db_asn_path?: string;
  db_city_path?: string;
}

/** 代理服务器配置 */
export interface ProxyConfig {
  server_port: number;
}

/** API 服务器配置 */
export interface ApiConfig {
  server_port: number;
  key: string;
}

/** 应用全量配置 */
export interface AppConfig {
  debug?: boolean;
  templates_dir: string;
  proxy: ProxyConfig;
  api: ApiConfig;
  browser_challenge: BrowserChallengeConfig;
  cache: CacheConfig;
  geoip?: GeoIPConfig;
  captcha?: CaptchaConfig;
  /** key 为 site 名称 */
  sites: Record<string, SiteConfig>;
}
