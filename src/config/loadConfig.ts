import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import type { AppConfig, CaptchaConfig, CaptchaProvider, SiteConfig } from "../types/config.ts";
import { env } from "./env.ts";

const RuleActionsSchema = z.object({
  allow: z.boolean().optional(),
  cache: z
    .object({
      enabled: z.boolean().optional(),
      ttl: z.number().int().positive().optional(),
      cacheKeyMode: z.enum(["path+query", "path"]).optional(),
    })
    .optional(),
  browser_challenge: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
}).optional();

const RuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  condition: z.string().min(1),
  actions: RuleActionsSchema,
  last: z.boolean().optional(),
});

const BackendSchema = z.object({
  url: z.string().url(),
  hostname: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

const SiteSchema = z.object({
  hostname: z.string().min(1),
  backend: BackendSchema,
  rules: z.array(RuleSchema).optional(),
});

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
  enabled: z.boolean().optional(),
  recaptcha: RecaptchaProviderSchema.default({ site_key: "", secret_key: "" }),
  hcaptcha: HCaptchaProviderSchema.default({ site_key: "", secret_key: "" }),
  geetest: GeeTestProviderSchema.default({ id: "", key: "" }),
  turnstile: TurnstileProviderSchema.default({ site_key: "", secret_key: "" }),
  funcaptcha: FunCaptchaProviderSchema.default({ public_key: "", private_key: "" }),
  aliyun: AliyunProviderSchema.default({ access_key_id: "", access_key_secret: "" }),
  tencent: TencentProviderSchema.default({ secret_id: "", secret_key: "" }),
});

const AppConfigSchema = z.object({
  debug: z.boolean().optional(),
  templatesDir: z.string().min(1).optional(),
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
    secret: z.string().min(1),
    pow: z.object({
      difficulty: z.number().int().min(1).max(64),
    }),
  }),
  cache: z.object({
    enabled: z.boolean(),
    ttl: z.number().int().positive(),
    cacheKeyMode: z.enum(["path+query", "path"]).default("path+query"),
    max_entries: z.number().int().positive(),
    max_body_bytes: z.number().int().positive(),
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
 * captcha.type 对应的 provider 必须 enabled=true 且凭据非空。
 */
function validateActiveProvider(captcha: CaptchaConfig): void {
  const type = captcha.type!;
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
    sites[name] = {
      ...site,
      backend: {
        ...site.backend,
        headers: headerTemplates,
      },
    };
  }

  // 校验 active captcha provider（仅在 type 已配置时）
  if (data.captcha?.type) {
    validateActiveProvider(data.captcha);
  }

  return {
    debug: data.debug ?? false,
    templatesDir: data.templatesDir ?? "./views",
    proxy: data.proxy,
    api: data.api,
    browser_challenge: data.browser_challenge,
    cache: data.cache,
    captcha: data.captcha,
    geoip: data.geoip,
    sites,
  };
}
