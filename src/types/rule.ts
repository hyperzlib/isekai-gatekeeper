import type { Context } from "koa";
import type { CloudflareHttp } from "./cloudflare";
import { CacheKeyModeType } from "./cache";
import { RulePresets } from "../utils/RulePresets";
import { RuleRateLimit } from "../utils/RuleRateLimit";

// ── Rule input types (injected at runtime) ──────────────────────────────────

/** Rules condition/exec evaluation context */
export interface RuleInput {
  ctx: Context;
  http: CloudflareHttp;
  presets: RulePresets;
  rateLimit: RuleRateLimit;
  state: Record<string, any>;
  matchGlob: (str: string, pattern: string | string[]) => boolean;
  match: (str: string, pattern: RegExp | RegExp[]) => boolean;
  matchExtractGroup: (str: string, pattern: RegExp | RegExp[], groupName?: number | string) => string | null;
  [key: string]: unknown;
}

/** cache_tags_callback evaluation context (extends RuleInput with cacheTags) */
export interface CacheKeyRuleInput extends RuleInput {
  cacheTags: string[];
}

// ── Function signatures ─────────────────────────────────────────────────────

export type RuleCondition = (input: RuleInput) => boolean | Promise<boolean>;
export type RuleExec = (input: RuleInput) => void | Promise<void>;
export type CacheTagsCallback = (input: CacheKeyRuleInput) => string[] | Promise<string[]>;
export type HeaderBuilder = (input: RuleInput) => string | null | undefined;

export type RuleTraceEvent =
  | { type: "site"; hostname: string; matched: boolean; siteHostname?: string | string[] }
  | { type: "default_decision"; decision: unknown }
  | { type: "rule_condition_start"; ruleId: string; description?: string }
  | { type: "rule_condition_result"; ruleId: string; matched: boolean }
  | { type: "rule_condition_error"; ruleId: string; error: unknown }
  | { type: "rule_exec_start"; ruleId: string }
  | { type: "rule_exec_done"; ruleId: string }
  | { type: "rule_exec_error"; ruleId: string; error: unknown }
  | { type: "rule_action"; ruleId: string; action: Pick<RuleAction, "block" | "return" | "cache" | "browser_challenge"> & { last?: boolean } }
  | { type: "rule_stop"; ruleId: string; reason: "block" | "return" | "last" }
  | { type: "cache_tags_callback_start"; source: "rule" | "global"; ruleId?: string }
  | { type: "cache_tags_callback_result"; source: "rule" | "global"; ruleId?: string; tags: string[] }
  | { type: "cache_tags_callback_error"; source: "rule" | "global"; ruleId?: string; error: unknown }
  | { type: "final_decision"; decision: unknown };

export type RuleTrace = (event: RuleTraceEvent) => void;

// ── Rule action types ───────────────────────────────────────────────────────

export interface RuleActionReturn {
  status?: number;
  headers?: Record<string, string | HeaderBuilder>;
  text?: string;
  tpl?: {
    id: string;
    data?: Record<string, any>;
  }
}

export interface RuleActionCachePolicy {
  enabled: boolean;
  ttl?: number;
  cache_key_mode?: CacheKeyModeType;
  cache_tags_callback?: CacheTagsCallback;
}

export interface RuleActionBrowserChallengePolicy {
  enabled: boolean;
  re_challenge?: boolean;
}

export type RuleAction = {
  /** 直接阻断请求 (返回 HTTP 444)，且不再继续匹配后续规则 */
  block?: boolean;
  /** 返回自定义响应，且不再继续匹配后续规则 */
  return?: RuleActionReturn;
  /** 设置缓存策略 */
  cache?: RuleActionCachePolicy;
  /** 设置浏览器挑战策略 */
  browser_challenge?: RuleActionBrowserChallengePolicy;
  /** 运行自定义操作 */
  exec?: RuleExec;
}

/** 规则配置 */
export type RuleConfig = {
  id: string;
  description?: string;
  condition: RuleCondition;
  /** last = true 则命中后不再继续匹配后续规则 */
  last?: boolean;
} & RuleAction;
