import type { Context } from "koa";
import type { CloudflareHttp } from "./cloudflare";
import { CacheKeyModeType } from "./cache";

// ── Rule input types (injected at runtime) ──────────────────────────────────

/** Rules condition/exec evaluation context */
export interface RuleInput {
  ctx: Context;
  http: CloudflareHttp;
  presets: Record<string, unknown> & { isCommonSearchEngineBot: boolean };
  rateLimit: Record<string, unknown>;
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