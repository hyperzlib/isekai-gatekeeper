/**
 * Worker 端 IPC 缓存客户端：通过 process.send 发起请求，通过 message 事件接收响应。
 */
import { randomUUID } from "node:crypto";
import {
  IpcCacheOp,
  IpcCacheRequest,
  IpcCacheResponse,
} from "../types/cache.ts";
import { isIpcCacheResponse } from "../utils/ipcCacheProtocol.ts";

const IPC_TIMEOUT_MS = 2000;

export function createWorkerIpcRequestFn(
  timeoutMs = IPC_TIMEOUT_MS,
): (
  op: IpcCacheOp,
  payload?: Omit<IpcCacheRequest, "kind" | "requestId" | "op">,
) => Promise<unknown> {
  if (typeof process.send !== "function") {
    throw new Error("IPC is unavailable in current process");
  }

  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  process.on("message", (message: unknown) => {
    if (!isIpcCacheResponse(message)) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.requestId);

    if (!message.ok) {
      entry.reject(new Error(message.error ?? "IPC cache request failed"));
      return;
    }

    entry.resolve(message.result);
  });

  return (op, payload) => {
    const requestId = randomUUID();
    const msg: IpcCacheRequest = {
      kind: "ipc-cache:req",
      requestId,
      op,
      ...payload,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`IPC cache request timeout (${op})`));
      }, timeoutMs);

      pending.set(requestId, { resolve, reject, timer });

      process.send?.(msg, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(err);
        }
      });
    });
  };
}
