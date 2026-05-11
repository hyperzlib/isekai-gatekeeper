/**
 * IPC 缓存消息类型判断工具（纯函数，无副作用）。
 */

import type {
  IpcCacheExecute,
  IpcCacheRequest,
  IpcCacheResponse,
  IpcCacheExecutedResponse,
} from "../types/cache.ts";

export function isIpcCacheRequest(value: unknown): value is IpcCacheRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "ipc-cache:req",
  );
}

export function isIpcCacheExecute(value: unknown): value is IpcCacheExecute {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "ipc-cache:exec",
  );
}

export function isIpcCacheExecutedResponse(
  value: unknown,
): value is IpcCacheExecutedResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "ipc-cache:res" &&
      typeof (value as { sourceWorkerId?: unknown }).sourceWorkerId === "number",
  );
}

export function isIpcCacheResponse(value: unknown): value is IpcCacheResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "ipc-cache:res",
  );
}
