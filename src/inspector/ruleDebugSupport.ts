import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Context } from "hono";
import type { AppConfig } from "../types/config.ts";
import type { Decision } from "../types/decision.ts";
import type { RuleTraceEvent } from "../types/rule.ts";
import { loadConfig } from "../config/loadConfig.ts";
import { CacheService } from "../services/cacheService.ts";
import { ProxyService } from "../services/proxyService.ts";
import { RateLimitService } from "../services/rateLimitService.ts";
import { RuleEngineService } from "../services/ruleEngineService.ts";
import { SiteResolver } from "../services/siteResolver.ts";
import type { AppContext, AppEnv } from "../types/hono.ts";

export type DebugCacheMode = "memory" | "config";

export interface DebugRequestConfig {
  name: string;
  method: string;
  url: string;
  host: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  clientIp: string;
  validatedClientId?: string | null;
  geoip?: Record<string, unknown>;
  bodyContentType?: string;
  bodyLength?: number;
}

export interface DebugHistoryFile {
  requests: DebugRequestConfig[];
}

export interface DebugRuntime {
  config: AppConfig;
  cacheMode: DebugCacheMode;
  cacheService: CacheService;
  rateLimitService: RateLimitService;
  siteResolver: SiteResolver;
  proxyService: ProxyService;
  ruleEngine: RuleEngineService;
}

export interface DebugEvaluationResult {
  decision: Decision;
  trace: RuleTraceEvent[];
  siteFound: boolean;
}

export const DEFAULT_HISTORY_PATH = resolve("data", "rule-debug.json");
export const EXAMPLE_HISTORY_PATH = resolve("data", "rule-debug.example.json");

const DEFAULT_REQUEST: DebugRequestConfig = {
  name: "Home page",
  method: "GET",
  url: "/",
  host: "localhost",
  headers: {
    "user-agent": "Mozilla/5.0 rule-debug",
  },
  cookies: {},
  clientIp: "127.0.0.1",
  validatedClientId: null,
  geoip: {},
  bodyContentType: "",
  bodyLength: 0,
};

export function createDefaultRequest(): DebugRequestConfig {
  return {
    ...DEFAULT_REQUEST,
    headers: { ...DEFAULT_REQUEST.headers },
    cookies: { ...DEFAULT_REQUEST.cookies },
    geoip: { ...DEFAULT_REQUEST.geoip },
  };
}

export function loadDebugHistory(
  historyPath = DEFAULT_HISTORY_PATH,
  examplePath = EXAMPLE_HISTORY_PATH,
): DebugHistoryFile {
  const sourcePath = existsSync(historyPath) ? historyPath : examplePath;
  if (!existsSync(sourcePath)) {
    return { requests: [createDefaultRequest()] };
  }

  const parsed = JSON.parse(readFileSync(sourcePath, "utf-8")) as Partial<DebugHistoryFile>;
  const requests = Array.isArray(parsed.requests) && parsed.requests.length > 0
    ? parsed.requests.map(normalizeRequest)
    : [createDefaultRequest()];
  return { requests };
}

export function saveDebugHistory(history: DebugHistoryFile, historyPath = DEFAULT_HISTORY_PATH): void {
  mkdirSync(dirname(historyPath), { recursive: true });
  const normalized: DebugHistoryFile = {
    requests: history.requests.map(normalizeRequest),
  };
  writeFileSync(historyPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

export async function createDebugRuntime(
  configPath: string,
  cacheMode: DebugCacheMode,
): Promise<DebugRuntime> {
  const loadedConfig = await loadConfig(configPath);
  const config = cacheMode === "memory" ? withMemoryCache(loadedConfig) : loadedConfig;

  const cacheService = new CacheService(config);
  await cacheService.init();

  const rateLimitService = new RateLimitService(cacheService);
  const siteResolver = new SiteResolver(config);
  const proxyService = new ProxyService(config, cacheService, siteResolver);
  const ruleEngine = new RuleEngineService(config, siteResolver);
  await ruleEngine.init();

  return {
    config,
    cacheMode,
    cacheService,
    rateLimitService,
    siteResolver,
    proxyService,
    ruleEngine,
  };
}

export async function evaluateDebugRequest(
  runtime: DebugRuntime,
  request: DebugRequestConfig,
): Promise<DebugEvaluationResult> {
  const ctx = createDebugContext(runtime, request);
  const trace: RuleTraceEvent[] = [];
  const decision = await runtime.ruleEngine.evaluate(ctx, {
    trace: (event) => trace.push(event),
  });
  return {
    decision,
    trace,
    siteFound: !!ctx.get("currentSite"),
  };
}

export function createDebugContext(runtime: DebugRuntime, request: DebugRequestConfig): AppContext {
  const normalized = normalizeRequest(request);

  const headers = normalizeHeaders(normalized.headers);
  headers["host"] = normalized.host;
  headers["x-forwarded-for"] = normalized.clientIp || "127.0.0.1";
  if (normalized.bodyContentType) headers["content-type"] = normalized.bodyContentType;
  if ((normalized.bodyLength ?? 0) > 0) headers["content-length"] = String(normalized.bodyLength);
  const cookieHeader = cookiesToHeader(normalized.cookies);
  if (cookieHeader && !headers["cookie"]) headers["cookie"] = cookieHeader;

  const rawBody = ".".repeat(Math.max(0, Math.floor(normalized.bodyLength ?? 0)));
  const method = normalized.method || "GET";
  const absoluteUrl = new URL(normalized.url || "/", `http://${normalized.host}`);
  const init: RequestInit = { method, headers };
  if (rawBody && method !== "GET" && method !== "HEAD") {
    init.body = rawBody;
  }
  const ctx = new Context<AppEnv>(new Request(absoluteUrl.toString(), init), {
    env: {},
    path: absoluteUrl.pathname,
  }) as AppContext;

  ctx.set("appConfig", runtime.config);
  ctx.set("cacheService", runtime.cacheService);
  ctx.set("rateLimitService", runtime.rateLimitService);
  ctx.set("siteResolver", runtime.siteResolver);
  ctx.set("proxyService", runtime.proxyService);
  ctx.set("ruleEngine", runtime.ruleEngine);
  ctx.set("geoip", normalized.geoip as AppContext["var"]["geoip"]);
  ctx.set("validatedClientId", normalized.validatedClientId ?? null);
  ctx.set("requestIp", normalized.clientIp || "127.0.0.1");

  const site = runtime.siteResolver.resolve(ctx);
  if (site) {
    ctx.set("currentSiteId", site.id);
    ctx.set("currentSite", site.config);
    ctx.set("currentSiteMatchedHost", site.matchedHost);
  }

  return ctx;
}

export function normalizeRequest(request: Partial<DebugRequestConfig>): DebugRequestConfig {
  const method = request.method === undefined ? DEFAULT_REQUEST.method : request.method;
  return {
    ...createDefaultRequest(),
    ...request,
    method: method.toUpperCase(),
    url: request.url ?? DEFAULT_REQUEST.url,
    host: request.host ?? DEFAULT_REQUEST.host,
    headers: normalizeHeaders(request.headers ?? DEFAULT_REQUEST.headers),
    cookies: normalizeStringMap(request.cookies ?? DEFAULT_REQUEST.cookies),
    clientIp: request.clientIp ?? DEFAULT_REQUEST.clientIp,
    validatedClientId: request.validatedClientId ?? null,
    geoip: request.geoip && typeof request.geoip === "object" ? request.geoip : {},
    bodyContentType: request.bodyContentType ?? "",
    bodyLength: Math.max(0, Math.floor(Number(request.bodyLength ?? 0) || 0)),
  };
}

function withMemoryCache(config: AppConfig): AppConfig {
  return {
    ...config,
    cache: {
      ...config.cache,
      provider: "memory",
      bun_redis: undefined,
    },
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.trim().toLowerCase();
    if (!name) continue;
    result[name] = String(value);
  }
  return result;
}

function normalizeStringMap(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const name = key.trim();
    if (!name) continue;
    result[name] = String(raw);
  }
  return result;
}

function cookiesToHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
    .join("; ");
}
