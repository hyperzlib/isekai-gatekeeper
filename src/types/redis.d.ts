declare module "redis" {
  export interface RedisClientOptions {
    url?: string;
  }

  export interface RedisClientType {
    isOpen?: boolean;
    connect(): Promise<unknown>;
    ping(): Promise<string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
    del(keys: string | string[]): Promise<number>;
    sendCommand(args: string[]): Promise<unknown>;
  }

  export function createClient(options?: RedisClientOptions): RedisClientType;
}
