import { ICacheStore, IpcCacheOp } from "../../types/cache.ts";

type RequestPayload = {
  key?: string;
  prefix?: string;
  value?: unknown;
  ttl?: number;
};

type RequestFn = (op: IpcCacheOp, payload?: RequestPayload) => Promise<unknown>;

export class IpcCacheStore implements ICacheStore {
  constructor(private readonly request: RequestFn) {}

  public async init(): Promise<void> {
    await this.request("ping");
  }

  public async get<T>(key: string): Promise<T | null> {
    const result = await this.request("get", { key });
    if (result === undefined || result === null) return null;
    return result as T;
  }

  public async set<T>(key: string, resp: T, ttl?: number): Promise<void> {
    await this.request("set", { key, value: resp, ttl });
  }

  public async delete(key: string): Promise<void> {
    await this.request("delete", { key });
  }

  public async deleteByPrefix(prefix: string): Promise<number> {
    const result = await this.request("deleteByPrefix", { prefix });
    return Number(result ?? 0);
  }

  public async size(): Promise<number> {
    const result = await this.request("size");
    return Number(result ?? 0);
  }
}
