declare module "redis" {
  export interface RedisClientOptions {
    url?: string;
  }

  export const RESP_TYPES: {
    BLOB_STRING: symbol;
  };

  export interface RedisClientType<TGetValue = string> {
    isOpen?: boolean;
    connect(): Promise<unknown>;
    ping(): Promise<string>;
    get(key: string): Promise<TGetValue | null>;
    set(key: string, value: string | Buffer, options?: { EX?: number }): Promise<unknown>;
    del(keys: string | string[]): Promise<number>;
    sendCommand(args: string[]): Promise<unknown>;
    withTypeMapping(mapping: Record<symbol, typeof Buffer>): RedisClientType<Buffer>;
  }

  export function createClient(options?: RedisClientOptions): RedisClientType;
}
