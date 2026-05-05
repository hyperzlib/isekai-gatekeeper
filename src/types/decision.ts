import { CacheKeyModeType } from "./cache";
import { RuleAction } from "./rule";

/** 合并后的缓存策略 */
export interface CachePolicy {
  enabled: boolean;
  ttl: number;
  cache_key_mode: CacheKeyModeType;
}

/** 合并后的浏览器挑战策略 */
export interface BrowserChallengePolicy {
  enabled: boolean;
}

/** 规则引擎的合并决策结果 */
export type Decision = RuleAction & {
  /** 根据 cachePolicy.key 计算得出的实际缓存键 */
  cache_key: string;
}

/** 传入规则条件函数的 HTTP 请求上下文 */
export interface HttpRequestContext {
  uri: {
    path: string;
    query: string;
  };
  origin: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  method: string;
}

/** 规则引擎的请求上下文 */
export interface RequestContext {
  http: {
    request: HttpRequestContext;
  };
}
