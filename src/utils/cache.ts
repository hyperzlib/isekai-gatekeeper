import { CacheKeyModeType } from "../types/cache";

export function escapeCacheKeyComponent(component: string): string {
  return component.replace(/:/g, "%3A").replace(/\//g, ":").replace(/^:/, "/").replace(/:$/, ":/").replace(/\|/g, "%7C");
}

export const PAGE_CACHE_KEY_PREFIX = "page_cache:";

export function makePageCacheKey(siteId: string, pathName: string, queryString: string, strategy: CacheKeyModeType): string {
  if (strategy === "path") {
    return PAGE_CACHE_KEY_PREFIX + escapeCacheKeyComponent(siteId) + ":" + escapeCacheKeyComponent(pathName);
  } else {
    if (queryString.length > 0 && queryString[0] === "?") {
      queryString = queryString.substring(1);
    }
    
    const sortedQuery = new URLSearchParams(queryString);
    if (sortedQuery.size === 0) {
      return PAGE_CACHE_KEY_PREFIX + escapeCacheKeyComponent(siteId) + ":" + escapeCacheKeyComponent(pathName);
    }

    // 排序查询参数，确保缓存键的一致性
    sortedQuery.sort();
    return PAGE_CACHE_KEY_PREFIX + escapeCacheKeyComponent(siteId) + ":" + escapeCacheKeyComponent(pathName) + ":?" + escapeCacheKeyComponent(sortedQuery.toString());
  }
}