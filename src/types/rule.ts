import { CacheKeyModeType } from "./cache";

export interface RuleActionReturn {
  status?: number;
  headers?: Record<string, string>;
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
}

export interface RuleActionBrowserChallengePolicy {
  enabled: boolean;
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
}

/** 规则配置 */
export type RuleConfig = {
  id: string;
  description?: string;
  condition: string;
  /** last = true 则命中后不再继续匹配后续规则 */
  last?: boolean;
} & RuleAction;