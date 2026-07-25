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

/** 规则引擎 resolve 后的 return 动作（此时headers的callback已展开为string） */
export interface ResolvedReturn {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  tpl?: {
    id: string;
    data?: Record<string, any>;
  };
}

/** 规则引擎的合并决策结果 */
export type Decision = Omit<RuleAction, 'exec' | 'return'> & {
  /** 根据 cachePolicy.key 计算得出的实际缓存键 */
  cache_key: string;
  /** 缓存标签（由 cache_tags_callback 链式执行产出） */
  cache_tags?: string[];
  /** 已 resolve 的 return 动作 */
  return?: ResolvedReturn;
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
