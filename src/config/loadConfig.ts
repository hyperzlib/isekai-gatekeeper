import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import type { AppConfig, CaptchaConfig, CaptchaProvider, SiteConfig } from "../types/config.ts";
import { env } from "./env.ts";

//#region 规则配置
const RuleActionReturnSchema = z.object({
  status: z.number().int().optional(),
  headers: z.record(z.string()).optional(),
  text: z.string().optional(),
  tpl: z
    .object({
      id: z.string().min(1),
      data: z.record(z.any()).optional(),
    })
    .optional(),
});

const RuleActionCachePolicySchema = z.object({
  enabled: z.boolean(),
  ttl: z.number().int().positive().optional(),
  cache_key_mode: z.enum(["path+query", "path"]).optional(),
});

const RuleActionBrowserChallengePolicySchema = z.object({
  enabled: z.boolean(),
});

const RuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  condition: z.string().min(1),
  last: z.boolean().optional(),
  block: z.boolean().optional(),
  return: RuleActionReturnSchema.optional(),
  cache: RuleActionCachePolicySchema.optional(),
  browser_challenge: RuleActionBrowserChallengePolicySchema.optional(),
});
//#endregion

const BackendSchema = z.object({
  hostname: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const SiteSchema = z.object({
  hostname: z.union([z.string(), z.array(z.string())]),
  backend: BackendSchema,
  rules: z.array(RuleSchema).optional(),
});

//#region 验证码配置
const CaptchaProviderSchema = z.enum([
  "recaptcha",
  "hcaptcha",
  "geetest",
  "turnstile",
  "funcaptcha",
  "aliyun",
  "tencent",
]);

const RecaptchaProviderSchema = z.object({
  site_key: z.string(),
  secret_key: z.string(),
  api_domain: z.string().optional(),
  js_domain: z.string().optional(),
});

const HCaptchaProviderSchema = z.object({
  site_key: z.string(),
  secret_key: z.string(),
});

const GeeTestProviderSchema = z.object({
  id: z.string(),
  key: z.string(),
});

const TurnstileProviderSchema = z.object({
  site_key: z.string(),
  secret_key: z.string(),
});

const FunCaptchaProviderSchema = z.object({
  public_key: z.string(),
  private_key: z.string(),
});

const AliyunProviderSchema = z.object({
  access_key_id: z.string(),
  access_key_secret: z.string(),
});

const TencentProviderSchema = z.object({
  secret_id: z.string(),
  secret_key: z.string(),
});

const CaptchaSchema = z.object({
  type: CaptchaProviderSchema.optional(),
  enabled: z.boolean().default(false),
  recaptcha: RecaptchaProviderSchema.default({ site_key: "", secret_key: "" }),
  hcaptcha: HCaptchaProviderSchema.default({ site_key: "", secret_key: "" }),
  geetest: GeeTestProviderSchema.default({ id: "", key: "" }),
  turnstile: TurnstileProviderSchema.default({ site_key: "", secret_key: "" }),
  funcaptcha: FunCaptchaProviderSchema.default({ public_key: "", private_key: "" }),
  aliyun: AliyunProviderSchema.default({ access_key_id: "", access_key_secret: "" }),
  tencent: TencentProviderSchema.default({ secret_id: "", secret_key: "" }),
});
//#endregion

//#region 缓存配置
const BunRedisConfigSchema = z.object({
  url: z.string().min(1),
});
//#endregion

const AppConfigSchema = z.object({
  debug: z.boolean().optional(),
  templates_dir: z.string().min(1).default("./views"),
  proxy: z.object({
    server_port: z.number().int().min(1).max(65535),
  }),
  api: z.object({
    server_port: z.number().int().min(1).max(65535),
    key: z.string().min(1),
  }),
  browser_challenge: z.object({
    enabled: z.boolean(),
    cookie_ttl: z.number().int().positive(),
    challenge_ttl: z.number().int().positive(),
    tpl: z.string().optional(),
    secret: z.string().min(1),
    pow: z.object({
      difficulty: z.number().int().min(1).max(64),
    }),
  }),
  cache: z.object({
    enabled: z.boolean(),
    default_ttl: z.number().int().positive(),
    provider: z.enum(["memory", "bun+redis"]).default("memory"),
    bun_redis: BunRedisConfigSchema.optional(),
    cache_key_mode: z.enum(["path+query", "path"]).default("path+query"),
    max_entries: z.number().int().positive(),
    max_body_bytes: z.number().int().positive(),
    allowed_mimetypes: z.array(z.string()).default([
      "text/html", "application/json", "text/plain", "text/css", "application/javascript", "text/javascript",
    ]),
  }),
  captcha: CaptchaSchema.optional(),
  geoip: z.object({
    enabled: z.boolean(),
    db_country_path: z.string().optional(),
    db_asn_path: z.string().optional(),
    db_city_path: z.string().optional(),
  }).optional(),
  site: z.record(SiteSchema),
});

/**
 * 校验 active captcha provider：
 * - captcha.enabled=true 时，type 不能为空
 * - captcha.type 对应的 provider 凭据非空。
 */
function validateActiveProvider(captcha: CaptchaConfig): void {
  if (!captcha.enabled) return;

  const type = captcha.type;
  if (!type) {
    throw new Error(
      "Config validation failed:\n  field=captcha.type message=captcha.enabled=true 时 type 不能为空",
    );
  }

  const providerCfg = captcha[type];

  // 验证必填凭据非空
  const emptyFields = getEmptyCredentialFields(type, providerCfg as unknown as Record<string, unknown>);
  if (emptyFields.length > 0) {
    throw new Error(
      `Config validation failed:\n${emptyFields
        .map((f) => `  field=captcha.${type}.${f} message=Required credential is empty`)
        .join("\n")}`,
    );
  }
}

function getEmptyCredentialFields(
  provider: CaptchaProvider,
  cfg: Record<string, unknown>,
): string[] {
  const requiredFields: Record<CaptchaProvider, string[]> = {
    recaptcha: ["site_key", "secret_key"],
    hcaptcha: ["site_key", "secret_key"],
    geetest: ["id", "key"],
    turnstile: ["site_key", "secret_key"],
    funcaptcha: ["public_key", "private_key"],
    aliyun: ["access_key_id", "access_key_secret"],
    tencent: ["secret_id", "secret_key"],
  };
  const fields = requiredFields[provider] ?? [];
  return fields.filter((f) => !cfg[f]);
}

/**
 * 从 TOML 文件加载并校验应用配置。
 * 校验失败时抛出错误，拒绝启动。
 */
export function loadConfig(): AppConfig {
  const raw = readFileSync(env.CONFIG_PATH, "utf-8");
  const parsed = parseTOML(raw);
  const result = AppConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  field=${i.path.join(".")} message=${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const data = result.data;

  // 预渲染所有 Handlebars 模板
  let sites: Record<string, SiteConfig> = {};
  for (const [name, site] of Object.entries(data.site)) {
    const headerTemplates: Record<string, HandlebarsTemplateDelegate> = {};
    for (const [key, tpl] of Object.entries(site.backend.headers ?? {})) {
      headerTemplates[key] = Handlebars.compile(tpl);
    }

    let hostname = site.hostname;
    if (Array.isArray(hostname)) {
      hostname = hostname.map((h) => h.toLowerCase());
    } else {
      hostname = hostname.toLowerCase();
    }

    sites[name] = {
      ...site,
      hostname,
      backend: {
        ...site.backend,
        headers: headerTemplates,
      },
    };
  }

  // 校验 active captcha provider（captcha 节存在时）
  if (data.captcha) {
    validateActiveProvider(data.captcha);
  }

  return {
    debug: data.debug ?? false,
    templates_dir: data.templates_dir ?? "./views",
    proxy: data.proxy,
    api: data.api,
    browser_challenge: data.browser_challenge,
    cache: data.cache,
    captcha: data.captcha,
    geoip: data.geoip,
    sites,
  };
}
