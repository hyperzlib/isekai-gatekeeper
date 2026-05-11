/**
 * 将 IPC 缓存客户端和 MemoryCacheStore 连接为用于 worker 的 IpcCacheStore。
 */
import { loadConfig } from "../config/loadConfig.ts";
import { CacheService } from "../services/cacheService.ts";
import { createWorkerIpcRequestFn } from "../cluster/ipcClient.ts";
import type { AppConfig } from "../types/config.ts";
import { IpcCacheStore } from "../services/cacheStores/ipcCacheStore.ts";

export async function createWorkerCacheService(): Promise<{
  cfg: AppConfig;
  cacheService: CacheService;
}> {
  const cfg = loadConfig();

  if (cfg.cluster.enabled && cfg.cache.provider === "memory") {
    const ipcStore = new IpcCacheStore(createWorkerIpcRequestFn());
    const cacheService = new CacheService(cfg, { store: ipcStore });
    await cacheService.init();
    return { cfg, cacheService };
  }

  const cacheService = new CacheService(cfg);
  await cacheService.init();
  return { cfg, cacheService };
}
