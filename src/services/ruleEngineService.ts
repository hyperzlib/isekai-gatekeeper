import Koa, { Context } from "koa";
import type { SiteConfig, AppConfig } from "../types/config.ts";
import type {
  RuleActionCachePolicy, RuleActionReturn, RuleConfig,
  RuleCondition, RuleExec, CacheTagsCallback, RuleInput, CacheKeyRuleInput as CacheTagRuleInput,
  RuleTrace,
} from "../types/rule.ts";
import type { Decision, CachePolicy, BrowserChallengePolicy, ResolvedReturn } from "../types/decision.ts";
import { RulePresets } from "../utils/RulePresets.ts";
import { toCloudflareHttp } from "../utils/http.ts";
import type { CloudflareHttp } from "../types/cloudflare.ts";
import { CacheKeyModeType } from "../types/cache.ts";
import { makePageCacheKey } from "../utils/cache.ts";
import { RuleRateLimit } from "../utils/RuleRateLimit.ts";
import { ruleExpressionTools } from "../utils/RuleTools.ts";

/** Runtime evaluation context passed to rule functions */
type ExpressionGlobal = RuleInput & {
  ctx: Context;
  http: CloudflareHttp;
  presets: RulePresets;
  rateLimit: RuleRateLimit;
  state: Record<string, any>;
  matchGlob: typeof ruleExpressionTools.matchGlob;
  match: typeof ruleExpressionTools.match;
  matchExtractGroup: typeof ruleExpressionTools.matchExtractGroup;
};

type CacheTagExpressionGlobal = ExpressionGlobal & CacheTagRuleInput & {
  cacheTags: string[];
};

interface CompiledSite {
  rules: RuleConfig[];
  siteConfig: SiteConfig;
}

export interface RuleEvaluateOptions {
  trace?: RuleTrace;
}

export class RuleEngineService {
  private debug = false;
  private readonly compiledSites: Map<string, CompiledSite> = new Map();
  private readonly appConfig: AppConfig;

  constructor(appConfig: AppConfig) {
    this.appConfig = appConfig;
    this.debug = appConfig.debug ?? false;
  }

  async init() {
    for (const [name, site] of Object.entries(this.appConfig.sites)) {
      const rules = site.rules ?? [];
      if (Array.isArray(site.hostname)) {
        for (const hostname of site.hostname) {
          this.compiledSites.set(hostname, { rules, siteConfig: site });
        }
      } else if (typeof site.hostname === "string") {
        this.compiledSites.set(site.hostname, { rules, siteConfig: site });
      }
    }
  }

  /** 根据 Host 查找对应 site 配置，无匹配返回 null。 */
  getSiteByHostname(hostname: string): SiteConfig | null {
    const entry = this.compiledSites.get(hostname);
    return entry?.siteConfig ?? null;
  }

  /** 对请求上下文执行 multi-match 规则评估，返回合并决策。 */
  async evaluate(ctx: Context, options: RuleEvaluateOptions = {}): Promise<Decision> {
    const trace = options.trace;
    const hostname = ctx.request.headers["host"] ?? "";
    const entry = this.compiledSites.get(hostname);

    // 默认决策
    const defaultCachePolicy: CachePolicy = {
      enabled: this.appConfig.cache.enabled,
      ttl: this.appConfig.cache.default_ttl,
      cache_key_mode: this.appConfig.cache.cache_key_mode,
    };
    const defaultChallenge: BrowserChallengePolicy = {
      enabled: this.appConfig.browser_challenge.enabled,
    };

    trace?.({
      type: "site",
      hostname,
      matched: !!entry,
      siteHostname: entry?.siteConfig.hostname,
    });

    if (!entry) {
      const decision: Decision = {
        block: false,
        cache: defaultCachePolicy,
        browser_challenge: defaultChallenge,
        cache_key: makePageCacheKey(ctx.currentSiteId || "unknown", ctx.URL.pathname, ctx.URL.search, defaultCachePolicy.cache_key_mode),
      };
      trace?.({ type: "default_decision", decision });
      trace?.({ type: "final_decision", decision });
      return decision;
    }

    let isBlocked = false;
    let returnData: ResolvedReturn | undefined;
    let cachePolicy: RuleActionCachePolicy = { ...defaultCachePolicy };
    let browserChallengePolicy: BrowserChallengePolicy = { ...defaultChallenge };
    const matchedCallbacks: { ruleId: string; callback: CacheTagsCallback }[] = [];

    ctx.state.ruleEngineState ??= {};
    const expressionGlobal: ExpressionGlobal = {
      ctx,
      http: toCloudflareHttp(ctx),
      presets: new RulePresets(ctx),
      rateLimit: new RuleRateLimit(ctx),
      state: ctx.state.ruleEngineState,
      ...ruleExpressionTools,
    } as ExpressionGlobal;

    if (entry.rules.length > 0) {
      for (const rule of entry.rules) {
        let matches: boolean;
        trace?.({ type: "rule_condition_start", ruleId: rule.id, description: rule.description });
        try {
          matches = await rule.condition(expressionGlobal);
          trace?.({ type: "rule_condition_result", ruleId: rule.id, matched: matches });
        } catch (e) {
          trace?.({ type: "rule_condition_error", ruleId: rule.id, error: e });
          continue;
        }
        if (!matches) continue;

        if (this.debug) {
          console.log(`Rule matched: ${rule.id} (${rule.description ?? "no description"})`);
        }

        if (rule.exec) {
          trace?.({ type: "rule_exec_start", ruleId: rule.id });
          try {
            await rule.exec(expressionGlobal);
            trace?.({ type: "rule_exec_done", ruleId: rule.id });
          } catch (e) {
            trace?.({ type: "rule_exec_error", ruleId: rule.id, error: e });
            console.log(`Error executing custom script in rule ${rule.id}:`, e);
          }
        }

        if (rule.cache?.cache_tags_callback) {
          matchedCallbacks.push({ ruleId: rule.id, callback: rule.cache.cache_tags_callback });
        }

        // block 与 return 都是终止动作
        if (rule.block || rule.return) {
          isBlocked = !!rule.block;
          // Resolve headers: string → 直接使用，HeaderBuilder 函数 → 调用后取值（null/undefined 跳过）
          if (rule.return) {
            const resolvedHeaders: Record<string, string> = {};
            if (rule.return.headers) {
              for (const [k, v] of Object.entries(rule.return.headers)) {
                const resolved = typeof v === "function" ? v(expressionGlobal) : v;
                if (resolved != null) {
                  resolvedHeaders[k] = resolved;
                }
              }
            }
            returnData = {
              status: rule.return.status,
              headers: Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
              text: rule.return.text,
              tpl: rule.return.tpl,
            };
          }
          cachePolicy = { enabled: false, ttl: 1, cache_key_mode: "path" as CacheKeyModeType };
          browserChallengePolicy = { enabled: false };
          trace?.({
            type: "rule_action",
            ruleId: rule.id,
            action: {
              block: rule.block,
              return: rule.return,
              cache: rule.cache,
              browser_challenge: rule.browser_challenge,
              last: rule.last,
            },
          });
          trace?.({ type: "rule_stop", ruleId: rule.id, reason: rule.block ? "block" : "return" });
          break;
        }

        // 后命中覆盖
        if (rule.cache) {
          cachePolicy = { ...cachePolicy, ...rule.cache };
        }

        if (rule.browser_challenge) {
          browserChallengePolicy = { ...browserChallengePolicy, ...rule.browser_challenge };
        }

        trace?.({
          type: "rule_action",
          ruleId: rule.id,
          action: {
            block: rule.block,
            return: rule.return,
            cache: rule.cache,
            browser_challenge: rule.browser_challenge,
            last: rule.last,
          },
        });

        if (rule.last) {
          trace?.({ type: "rule_stop", ruleId: rule.id, reason: "last" });
          break;
        }
      }
    }

    // 链式执行所有匹配规则的 cache_tags_callback
    let cacheTags: string[] | undefined;
    if (matchedCallbacks.length > 0) {
      let tags: string[] = [];
      for (const { ruleId, callback } of matchedCallbacks) {
        try {
          trace?.({ type: "cache_tags_callback_start", source: "rule", ruleId });
          const result = await callback({ ...expressionGlobal, cacheTags: tags } as CacheTagExpressionGlobal);
          if (Array.isArray(result)) tags = result;
          trace?.({ type: "cache_tags_callback_result", source: "rule", ruleId, tags });
        } catch (e) {
          trace?.({ type: "cache_tags_callback_error", source: "rule", ruleId, error: e });
          console.error("[RuleEngine] cache_tags_callback execution error:", e);
        }
      }
      if (tags.length > 0) cacheTags = tags;
    } else if (this.appConfig.cache.cache_tags_callback) {
      try {
        trace?.({ type: "cache_tags_callback_start", source: "global" });
        const tags = await this.appConfig.cache.cache_tags_callback({
          ...expressionGlobal,
          cacheTags: [],
        } as CacheTagExpressionGlobal);
        if (Array.isArray(tags) && tags.length > 0) cacheTags = tags;
        trace?.({ type: "cache_tags_callback_result", source: "global", tags: Array.isArray(tags) ? tags : [] });
      } catch (e) {
        trace?.({ type: "cache_tags_callback_error", source: "global", error: e });
        console.error("[RuleEngine] global cache_tags_callback execution error:", e);
      }
    }

    const cacheKey = makePageCacheKey(
      ctx.currentSiteId || "unknown",
      ctx.URL.pathname,
      ctx.URL.search,
      cachePolicy.cache_key_mode ?? defaultCachePolicy.cache_key_mode,
    );

    const decision: Decision = {
      block: isBlocked,
      return: returnData,
      cache: cachePolicy,
      browser_challenge: browserChallengePolicy,
      cache_key: cacheKey,
      cache_tags: cacheTags,
    };
    trace?.({ type: "final_decision", decision });
    return decision;
  }
}
