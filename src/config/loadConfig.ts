import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import type { AppConfig, CaptchaConfig, SiteConfig } from "../types/config.ts";
import type { CacheTagsCallback } from "../types/rule.ts";
import { env } from "./env.ts";

// ── esbuild transform + eval a .ts config file ──────────────────────────────

async function loadConfigModule(configPath: string): Promise<Record<string, unknown>> {
  const source = readFileSync(configPath, "utf-8");
  const result = await transform(source, {
    loader: "ts",
    format: "cjs",
    target: "esnext",
    sourcemap: "inline",
  });

  const fn = new Function("module", result.code);
  const module_: { exports: Record<string, unknown> } = { exports: {} };
  fn(module_);
  
  if (!module_.exports.default || typeof module_.exports.default !== "object") {
    throw new Error(`Config file must export default { ... }, got ${typeof module_.exports.default}`);
  }
  return module_.exports.default as Record<string, unknown>;
}

// ── Provider credential validation ──────────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string[]> = {
  recaptcha: ["site_key", "secret_key"],
  hcaptcha: ["site_key", "secret_key"],
  geetest: ["id", "key"],
  turnstile: ["site_key", "secret_key"],
  funcaptcha: ["public_key", "private_key"],
  aliyun: ["access_key_id", "access_key_secret"],
  tencent: ["secret_id", "secret_key"],
};

function validateActiveProvider(captcha: CaptchaConfig): void {
  if (!captcha.enabled || !captcha.type) return;
  const fields = REQUIRED_FIELDS[captcha.type] ?? [];
  const cfg = (captcha[captcha.type] ?? {}) as unknown as Record<string, unknown>;
  const emptyFields = fields.filter((f) => !cfg[f]);
  if (emptyFields.length > 0) {
    throw new Error(
      `Config validation failed:\n${emptyFields
        .map((f) => `  field=captcha.${captcha.type}.${f} message=Required credential is empty`)
        .join("\n")}`,
    );
  }
}

// ── Main loader ─────────────────────────────────────────────────────────────

export async function loadConfig(configPath = env.CONFIG_PATH): Promise<AppConfig> {
  const raw = await loadConfigModule(configPath);

  const proxy = raw.proxy as Record<string, unknown>;
  const api = raw.api as Record<string, unknown>;
  const bc = raw.browser_challenge as Record<string, unknown>;
  const cacheCfg = raw.cache as Record<string, unknown>;
  const bcPow = (bc.pow ?? {}) as Record<string, unknown>;
  const bunRedis = (cacheCfg.bun_redis ?? {}) as Record<string, unknown>;
  const redis = (cacheCfg.redis ?? {}) as Record<string, unknown>;

  const debug = typeof raw.debug === "boolean" ? raw.debug : undefined;
  const templates_dir = typeof raw.templates_dir === "string" ? raw.templates_dir : "./views";

  // 预处理站点
  const rawSites = raw.sites as Record<string, Record<string, unknown>>;
  const sites: Record<string, SiteConfig> = {};

  for (const [name, site] of Object.entries(rawSites)) {
    const backend = site.backend as Record<string, unknown>;
    let hostname = site.hostname;
    if (Array.isArray(hostname)) {
      hostname = hostname.map((h: string) => h.toLowerCase());
    } else if (typeof hostname === "string") {
      hostname = hostname.toLowerCase();
    }

    sites[name] = {
      hostname: hostname as string | string[],
      backend: {
        url: backend.url as string,
        hostname: backend.hostname as string | undefined,
        headers: (backend.headers ?? {}) as Record<string, string | ((input: any) => string | null | undefined)>,
      },
      rules: (site.rules ?? []) as SiteConfig["rules"],
    } as SiteConfig;
  }

  // Captcha 校验
  const captcha = raw.captcha as CaptchaConfig | undefined;
  if (captcha) validateActiveProvider(captcha);

  return {
    debug,
    templates_dir,
    proxy: { server_port: proxy.server_port as number },
    api: { server_port: api.server_port as number, key: api.key as string },
    browser_challenge: {
      enabled: bc.enabled as boolean,
      tpl: bc.tpl as string | undefined,
      cookie_ttl: bc.cookie_ttl as number,
      challenge_ttl: bc.challenge_ttl as number,
      secret: bc.secret as string,
      pow: { difficulty: bcPow.difficulty as number },
    },
    cache: {
      enabled: cacheCfg.enabled as boolean,
      provider: (cacheCfg.provider ?? "memory") as "memory" | "bun+redis" | "redis",
      bun_redis: bunRedis.url ? { url: bunRedis.url as string } : undefined,
      redis: redis.url ? { url: redis.url as string } : undefined,
      default_ttl: cacheCfg.default_ttl as number,
      cache_key_mode: (cacheCfg.cache_key_mode ?? "path+query") as "path" | "path+query",
      cache_tags_callback: cacheCfg.cache_tags_callback as CacheTagsCallback | undefined,
      max_entries: cacheCfg.max_entries as number,
      max_body_bytes: cacheCfg.max_body_bytes as number,
      allowed_mimetypes: (cacheCfg.allowed_mimetypes ?? [
        "text/html", "application/json", "text/plain", "text/css", "application/javascript", "text/javascript",
      ]) as string[],
      bypass_after_challenge: (cacheCfg.bypass_after_challenge ?? true) as boolean,
    },
    captcha,
    geoip: raw.geoip as AppConfig["geoip"],
    sites,
  };
}
