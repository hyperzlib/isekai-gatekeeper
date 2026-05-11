/**
 * 独立缓存 worker：加载 MemoryCacheStore，通过 IPC 响应缓存命令。
 */
import { loadConfig } from "./config/loadConfig.ts";
import { MemoryCacheStore } from "./services/cacheStores/memoryCacheStore.ts";
import {
  isIpcCacheExecute,
} from "./utils/ipcCacheProtocol.ts";
import type { IpcCacheExecute, IpcCacheExecutedResponse } from "./types/cache.ts";

async function executeCacheOp(
  store: MemoryCacheStore,
  msg: IpcCacheExecute,
): Promise<unknown> {
  switch (msg.op) {
    case "ping":
      return "pong";
    case "get":
      return msg.key ? await store.get(msg.key) : null;
    case "set":
      if (!msg.key) throw new Error("Missing key for set");
      await store.set(msg.key, msg.value, msg.ttl);
      return true;
    case "delete":
      if (!msg.key) throw new Error("Missing key for delete");
      await store.delete(msg.key);
      return true;
    case "deleteByPrefix":
      if (!msg.prefix) throw new Error("Missing prefix for deleteByPrefix");
      return await store.deleteByPrefix(msg.prefix);
    case "size":
      return await store.size();
    default:
      throw new Error(`Unsupported IPC cache op: ${msg.op satisfies never}`);
  }
}

export async function runCacheWorker(): Promise<void> {
  const cfg = loadConfig();
  const cacheCfg = cfg.cache;

  const store = new MemoryCacheStore(
    cacheCfg.max_entries,
    cacheCfg.max_body_bytes,
    cacheCfg.default_ttl,
  );
  await store.init();

  process.on("message", async (message: unknown) => {
    if (!isIpcCacheExecute(message)) return;

    try {
      const result = await executeCacheOp(store, message);
      const response: IpcCacheExecutedResponse = {
        kind: "ipc-cache:res",
        requestId: message.requestId,
        sourceWorkerId: message.sourceWorkerId,
        ok: true,
        result,
      };
      process.send?.(response);
    } catch (err) {
      const response: IpcCacheExecutedResponse = {
        kind: "ipc-cache:res",
        requestId: message.requestId,
        sourceWorkerId: message.sourceWorkerId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      process.send?.(response);
    }
  });

  console.log(`[cache:${process.pid}] IPC cache worker ready`);
}
