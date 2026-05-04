import Koa, { Context } from "koa";
import type { RuleConfig, SiteConfig, AppConfig, CacheConfig } from "../types/config.ts";
import type { Decision, CachePolicy, BrowserChallengePolicy } from "../types/decision.ts";
import { RulePresets } from "../utils/RulePresets.ts";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";

type MatcherFunc = (ctx: Context, presets: RulePresets) => boolean;

/** 已编译的规则（条件函数在启动期生成） */
interface CompiledRule {
  raw: RuleConfig;
  matcher: MatcherFunc;
}

/** 每个 site 的已编译规则集 */
interface CompiledSite {
  rules: CompiledRule[];
  siteConfig: SiteConfig;
}

const EXAMPLE_REQUEST = {
  method: "GET",
  url: "/example/path?foo=bar",
  headers: {
    host: "example.com",
    "user-agent": "ExampleBot/1.0",
    accept: "text/html",
    cookie: "session=abc123",
  },
} as const;

/**
 * 允许的条件字段白名单（防止任意代码执行超出限制范围）。
 * 这里采用白名单字段校验：检查 condition 中访问的顶层对象名。
 */
const ALLOWED_ROOT_VARS = new Set(["http", "presets"]);

function validateConditionSyntax(id: string, condition: string): void {
  // 检查 condition 不含 import/require/fetch/eval/Function 等危险操作
  const forbidden = /\b(import|require|fetch|eval|Function|process|global|globalThis|Bun|Deno|Node)\b/;
  if (forbidden.test(condition)) {
    throw new Error(
      `rule=${id} field=condition message=Forbidden identifier in condition expression`,
    );
  }
}

function compileCondition(app: Koa, id: string, condition: string): MatcherFunc {
  validateConditionSyntax(id, condition);
  let fn: MatcherFunc;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("ctx", "presets", `"use strict"; return (${condition});`) as (
      ctx: Context,
      presets: RulePresets
    ) => boolean;
  } catch (e) {
    console.log(`Condition compilation error in rule ${id}:`, e);
    console.log("Condition source:", condition);
    throw new Error(
      `rule=${id} field=condition message=Syntax error: ${(e as Error).message}`,
    );
  }

  // 用示例数据测试执行
  try {
    const exampleRequest: IncomingMessage = new IncomingMessage(null as unknown as any);
    exampleRequest.method = EXAMPLE_REQUEST.method;
    exampleRequest.url = EXAMPLE_REQUEST.url;
    exampleRequest.headers = {};
    exampleRequest.httpVersion = "1.1";
    for (const [key, value] of Object.entries(EXAMPLE_REQUEST.headers)) {
      exampleRequest.headers[key] = value;
    }

    const exampleResponse: ServerResponse = new ServerResponse(exampleRequest);
    const exampleCtx = app.createContext(exampleRequest, exampleResponse);
    exampleCtx.request.header = {
      ...exampleCtx.request.header,
      ...EXAMPLE_REQUEST.headers,
    };

    const presets = new RulePresets(exampleCtx);
    fn(exampleCtx, presets);
  } catch (e) {
    if ((e as Error).message.startsWith(`rule=${id}`)) throw e;
    throw new Error(
      `rule=${id} field=condition message=Runtime error during test: ${(e as Error).message}`,
    );
  }

  return fn
}

export class RuleEngineService {
  private debug = false;
  private readonly compiledSites: Map<string, CompiledSite> = new Map();
  private readonly globalCacheConfig: CacheConfig;

  constructor(app: Koa, appConfig: AppConfig) {
    this.globalCacheConfig = appConfig.cache;
    this.debug = appConfig.debug ?? false;
    for (const [name, site] of Object.entries(appConfig.sites)) {
      const rules = site.rules ?? [];
      const compiled: CompiledRule[] = rules.map((rule) => ({
        raw: rule,
        matcher: compileCondition(app, rule.id, rule.condition),
      }));
      this.compiledSites.set(site.hostname, { rules: compiled, siteConfig: site });
    }
  }

  /**
   * 根据 Host 查找对应 site 配置，无匹配返回 null。
   */
  getSiteByHostname(hostname: string): SiteConfig | null {
    const entry = this.compiledSites.get(hostname);
    return entry?.siteConfig ?? null;
  }

  /**
   * 对请求上下文执行 multi-match 规则评估，返回合并决策。
   */
  evaluate(ctx: Context): Decision {
    const hostname = ctx.request.headers["host"] ?? "";
    const entry = this.compiledSites.get(hostname);

    // 默认决策
    const defaultCachePolicy: CachePolicy = {
      enabled: this.globalCacheConfig.enabled,
      ttl: this.globalCacheConfig.ttl,
      cacheKeyMode: "path+query",
    };
    const defaultChallenge: BrowserChallengePolicy = { enabled: true };

    if (!entry) {
      return {
        allow: false,
        cachePolicy: defaultCachePolicy,
        browserChallengePolicy: defaultChallenge,
        cacheKey: buildCacheKey(ctx, "path+query"),
      };
    }

    let allow = false;
    let cacheEnabled = this.globalCacheConfig.enabled;
    let cacheTtl = this.globalCacheConfig.ttl;
    let cacheKeyStrategy: "path+query" | "path" = "path+query";
    let challengeEnabled = true;

    for (const rule of entry.rules) {
      let matches: boolean;
      try {
        const presets = new RulePresets(ctx);
        matches = rule.matcher(ctx, presets);
      } catch {
        // 运行期 matcher 失败不影响其他规则
        continue;
      }
      if (!matches) continue;

      if (this.debug) {
        console.log(`Rule matched: ${rule.raw.id} (${rule.raw.description ?? "no description"})`);
      }

      const actions = rule.raw.actions ?? {};

      // 后命中覆盖
      if (actions.allow !== undefined) allow = actions.allow;
      if (actions.cache?.enabled !== undefined) cacheEnabled = actions.cache.enabled;
      if (actions.cache?.ttl !== undefined) cacheTtl = actions.cache.ttl;
      if (actions.cache?.cacheKeyMode !== undefined) cacheKeyStrategy = actions.cache.cacheKeyMode;
      if (actions.browser_challenge?.enabled !== undefined)
        challengeEnabled = actions.browser_challenge.enabled;

      if (rule.raw.last) break;
    }

    const cacheKey = buildCacheKey(ctx, cacheKeyStrategy);

    return {
      allow,
      cachePolicy: { enabled: cacheEnabled, ttl: cacheTtl, cacheKeyMode: cacheKeyStrategy },
      browserChallengePolicy: { enabled: challengeEnabled },
      cacheKey,
    };
  }
}

export function buildCacheKey(ctx: Context, strategy: "path+query" | "path"): string {
  const path = ctx.request.URL.pathname;
  if (strategy === "path") return path;
  const query = ctx.request.URL.search.slice(1);
  if (!query) return path;
  // 排序 query 参数保证幂等
  const sorted = new URLSearchParams(query);
  sorted.sort();
  return `${path}?${sorted.toString()}`;
}
