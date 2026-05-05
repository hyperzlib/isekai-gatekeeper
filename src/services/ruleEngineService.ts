import Koa, { Context } from "koa";
import type { SiteConfig, AppConfig, CacheConfig } from "../types/config.ts";
import type { RuleActionCachePolicy, RuleActionReturn, RuleConfig } from "../types/rule.ts";
import type { Decision, CachePolicy, BrowserChallengePolicy } from "../types/decision.ts";
import { RulePresets } from "../utils/RulePresets.ts";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";
import { ruleExpressionTools, RuleExpressionTools } from "../utils/RuleTools.ts";
import { toCloudflareHttp } from "../utils/http.ts";
import type { CloudflareHttp } from "../types/cloudflare.ts";

type ExpressionGlobal = {
  ctx: Context;
  http: CloudflareHttp;
  presets: RulePresets;
  state: Record<string, any>;
} & RuleExpressionTools;

type MatcherFunc = (input: ExpressionGlobal) => boolean;

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

const expressionGlobalKeys = new Set<keyof ExpressionGlobal>([
  'ctx', 'http', 'presets', 'state'
]);

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
    fn = new Function("input", `"use strict"; const { ${Array.from(expressionGlobalKeys).join(", ")} } = input; return (${condition});`) as (
      input: ExpressionGlobal
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

    fn({
      ctx: exampleCtx,
      http: toCloudflareHttp(exampleCtx),
      presets: new RulePresets(exampleCtx),
      state: {},
      ...ruleExpressionTools,
    });
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
  private readonly appConfig: AppConfig;

  constructor(app: Koa, appConfig: AppConfig) {
    this.appConfig = appConfig;
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
      enabled: this.appConfig.cache.enabled,
      ttl: this.appConfig.cache.default_ttl,
      cacheKeyMode: this.appConfig.cache.cache_key_mode,
    };
    const defaultChallenge: BrowserChallengePolicy = {
      enabled: this.appConfig.browser_challenge.enabled
    };

    if (!entry) {
      return {
        block: false,
        cache: defaultCachePolicy,
        browser_challenge: defaultChallenge,
        cache_key: buildCacheKey(ctx, defaultCachePolicy.cacheKeyMode),
      };
    }

    let isBlocked = false;
    let returnData: RuleActionReturn | undefined = undefined;
    let cachePolicy: RuleActionCachePolicy = { ...defaultCachePolicy };
    let browserChallengePolicy: BrowserChallengePolicy = { ...defaultChallenge };

    if (entry.rules.length > 0) {
      let expressionGlobal: ExpressionGlobal = {
        ctx,
        http: toCloudflareHttp(ctx),
        presets: new RulePresets(ctx),
        state: {},
        ...ruleExpressionTools,
      }

      for (const rule of entry.rules) {
        let matches: boolean;
        try {
          matches = rule.matcher(expressionGlobal);
        } catch {
          // 运行期 matcher 失败不影响其他规则
          continue;
        }
        if (!matches) continue;

        if (this.debug) {
          console.log(`Rule matched: ${rule.raw.id} (${rule.raw.description ?? "no description"})`);
        }

        // block 与 return 都是终止动作
        if (rule.raw.block || rule.raw.return) {
          isBlocked = !!rule.raw.block;
          returnData = rule.raw.return;

          // 禁止缓存和浏览器挑战
          cachePolicy = { enabled: false, ttl: 1, cache_key_mode: "path" };
          browserChallengePolicy = { enabled: false };

          break;
        }

        // 后命中覆盖
        if (rule.raw.cache) {
          cachePolicy = {
            ...cachePolicy,
            ...rule.raw.cache,
          }
        }

        if (rule.raw.browser_challenge) {
          browserChallengePolicy = {
            ...browserChallengePolicy,
            ...rule.raw.browser_challenge,
          }
        }

        if (rule.raw.last) break;
      }
    }

    const cacheKey = buildCacheKey(ctx, cachePolicy.cache_key_mode ?? defaultCachePolicy.cacheKeyMode);

    return {
      block: isBlocked,
      return: returnData,
      cache: cachePolicy,
      browser_challenge: browserChallengePolicy,
      cache_key: cacheKey,
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
