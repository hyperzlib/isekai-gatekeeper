/** 缓存条目结构 */
export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  cachedAt: number;
  ttl: number;
}

export interface ICacheStore {
  init(): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, resp: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>;
}

/** 页面缓存键 */
export type CacheKeyModeType = "path" | "path+query";

export type IpcCacheOp = "get" | "set" | "delete" | "deleteByPrefix" | "size" | "ping";

export interface IpcCacheRequest {
  kind: "ipc-cache:req";
  requestId: string;
  op: IpcCacheOp;
  key?: string;
  prefix?: string;
  value?: unknown;
  ttl?: number;
}

export interface IpcCacheExecute {
  kind: "ipc-cache:exec";
  requestId: string;
  op: IpcCacheOp;
  key?: string;
  prefix?: string;
  value?: unknown;
  ttl?: number;
  sourceWorkerId: number;
}

export interface IpcCacheResponse {
  kind: "ipc-cache:res";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface IpcCacheExecutedResponse extends IpcCacheResponse {
  sourceWorkerId: number;
}