import type {
  CachedResponse,
  CachedResponseMeta,
  ConsumeRateLimitOptions,
  ConsumeRateLimitResult,
  ICacheStore,
} from "../types/cache";
import type { RedisClientType } from "redis";

const TAG_KEY_PREFIX = "tagedCache:";
const CACHE_META_SUFFIX = ":meta";
const CACHE_BODY_SUFFIX = ":body";

/** 解析 tag 索引条目 "expiresAt_ms cacheKey"，未过期返回 cacheKey，否则 null */
function parseTagEntry(entry: string): { cacheKey: string; expired: boolean } | null {
  const idx = entry.indexOf(" ");
  if (idx <= 0) return null;
  const expiresAt = Number(entry.slice(0, idx));
  const cacheKey = entry.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || !cacheKey) return null;
  return { cacheKey, expired: expiresAt <= Date.now() };
}

function metaKey(key: string): string {
  return `${key}${CACHE_META_SUFFIX}`;
}

function bodyKey(key: string): string {
  return `${key}${CACHE_BODY_SUFFIX}`;
}

function logicalKeyFromMetaKey(key: string): string {
  return key.endsWith(CACHE_META_SUFFIX) ? key.slice(0, -CACHE_META_SUFFIX.length) : key;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scanResult(value: unknown): { cursor: string; keys: string[] } {
  if (Array.isArray(value)) {
    return { cursor: String(value[0] ?? "0"), keys: stringArray(value[1]) };
  }

  if (value && typeof value === "object") {
    const objectValue = value as { cursor?: unknown; keys?: unknown };
    return { cursor: String(objectValue.cursor ?? "0"), keys: stringArray(objectValue.keys) };
  }

  return { cursor: "0", keys: [] };
}

const RATE_LIMIT_CONSUME_SCRIPT = `
local key = KEYS[1]
local windowSec = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local windowMs = windowSec * 1000
local resetAt = math.floor(now / windowMs) * windowMs + windowMs

local count = tonumber(redis.call("HGET", key, "count"))
local storedResetAt = tonumber(redis.call("HGET", key, "resetAt"))
local firstLimitedMarkedRaw = redis.call("HGET", key, "firstLimitedMarked")
local firstLimitedMarked = firstLimitedMarkedRaw == "1"

if count == nil or storedResetAt == nil or now >= storedResetAt then
	count = 0
	storedResetAt = resetAt
	firstLimitedMarked = false
end

count = count + cost
local limited = count > maxRequests
local firstLimitedInWindow = limited and not firstLimitedMarked
if limited then
	firstLimitedMarked = true
end

local ttlSec = math.ceil((storedResetAt - now) / 1000)
if ttlSec < 1 then
	ttlSec = 1
end

redis.call("HSET", key, "count", count, "resetAt", storedResetAt, "firstLimitedMarked", firstLimitedMarked and "1" or "0")
redis.call("EXPIRE", key, ttlSec)

return { count, limited and 1 or 0, math.max(0, maxRequests - count), storedResetAt, firstLimitedInWindow and 1 or 0 }
`;

export class RedisCacheStore implements ICacheStore {
  private client?: RedisClientType;
  private readonly redisUrl: string;
  private readonly maxBodyBytes: number;
  private readonly defaultTtl: number;

  constructor(redisUrl: string, maxBodyBytes: number, defaultTtl: number = 300) {
    this.redisUrl = redisUrl;
    this.maxBodyBytes = maxBodyBytes;
    this.defaultTtl = defaultTtl;
  }

  public async init(): Promise<void> {
    const { createClient } = await import("redis");
    this.client = createClient({ url: this.redisUrl });
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    await this.client.ping();
  }

  public async get<T>(key: string): Promise<T | null> {
    const client = this.getClient();
    const raw = await client.get(key);
    if (raw == null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      await client.del(key);
      return null;
    }
  }

  public async set<T>(key: string, value: T, ttl?: number, _tags?: string[]): Promise<void> {
    const payload = JSON.stringify(value);
    if (payload.length > this.maxBodyBytes) return;

    await this.getClient().set(key, payload, { EX: this.resolveTtl(ttl) });
  }

  public async getCachedResponseMeta(key: string): Promise<CachedResponseMeta | null> {
    const client = this.getClient();
    const keyMeta = metaKey(key);
    const raw = await client.get(keyMeta);
    if (raw == null) return null;

    try {
      return JSON.parse(raw) as CachedResponseMeta;
    } catch {
      await client.del([keyMeta, bodyKey(key)]);
      return null;
    }
  }

  public async getCachedResponse(key: string): Promise<CachedResponse | null> {
    const client = this.getClient();
    const keyMeta = metaKey(key);
    const keyBody = bodyKey(key);
    const result = await client.sendCommand(["MGET", keyMeta, keyBody]) as Array<string | null>;
    const rawMeta = result[0];
    const body = result[1];
    if (rawMeta == null) return null;

    if (body == null) {
      await this.removeCachedResponseTagIndices(key);
      await client.del(keyMeta);
      return null;
    }

    try {
      const meta = JSON.parse(rawMeta) as CachedResponseMeta;
      return { ...meta, body };
    } catch {
      await client.del([keyMeta, keyBody]);
      return null;
    }
  }

  public async setCachedResponse(
    key: string,
    value: CachedResponse,
    ttl?: number,
    tags?: string[],
  ): Promise<void> {
    const client = this.getClient();
    const effectiveTtl = this.resolveTtl(ttl);
    const effectiveTags = tags ?? value.tags;
    const { body, ...meta } = { ...value, tags: effectiveTags };
    const metaPayload = JSON.stringify(meta);
    if (metaPayload.length + body.length > this.maxBodyBytes) return;

    await this.removeCachedResponseTagIndices(key);
    await client.set(metaKey(key), metaPayload, { EX: effectiveTtl });
    await client.set(bodyKey(key), body, { EX: effectiveTtl });

    if (effectiveTags && effectiveTags.length > 0) {
      const expiresAt = Date.now() + effectiveTtl * 1000;
      const entry = `${expiresAt} ${key}`;
      for (const tag of effectiveTags) {
        await client.sendCommand(["RPUSH", TAG_KEY_PREFIX + tag, entry]);
      }
    }
  }

  public async deleteCachedResponse(key: string): Promise<void> {
    await this.removeCachedResponseTagIndices(key);
    await this.getClient().del([metaKey(key), bodyKey(key)]);
  }

  public async consumeRateLimit(options: ConsumeRateLimitOptions): Promise<ConsumeRateLimitResult> {
    const result = await this.getClient().sendCommand([
      "EVAL",
      RATE_LIMIT_CONSUME_SCRIPT,
      "1",
      options.key,
      String(options.windowSec),
      String(options.maxRequests),
      String(options.cost),
      String(options.now),
    ]) as Array<number | string>;

    const values = result.map(Number);
    const current = values[0] ?? 0;
    const limited = values[1] ?? 0;
    const remaining = values[2] ?? 0;
    const resetAt = values[3] ?? 0;
    const firstLimitedInWindow = values[4] ?? 0;
    return {
      current,
      limited: limited === 1,
      remaining,
      resetAt,
      firstLimitedInWindow: firstLimitedInWindow === 1,
    };
  }

  public async delete(key: string): Promise<void> {
    await this.getClient().del(key);
  }

  public async deleteByPrefix(prefix: string): Promise<number> {
    const client = this.getClient();
    let cursor = "0";
    let deleted = 0;
    const logicalCacheKeys = new Set<string>();
    const plainKeys = new Set<string>();

    do {
      const resp = scanResult(await client.sendCommand(["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "200"]));

      for (const key of resp.keys) {
        if (key.endsWith(CACHE_META_SUFFIX)) {
          logicalCacheKeys.add(logicalKeyFromMetaKey(key));
        } else if (!key.endsWith(CACHE_BODY_SUFFIX)) {
          plainKeys.add(key);
        }
      }

      cursor = resp.cursor;
    } while (cursor !== "0");

    for (const key of logicalCacheKeys) {
      await this.deleteCachedResponse(key);
      deleted++;
    }

    if (plainKeys.size > 0) {
      const n = await client.del([...plainKeys]);
      deleted += Number(n);
    }

    return deleted;
  }

  public async deleteByTag(tag: string): Promise<number> {
    const client = this.getClient();
    const tagKey = TAG_KEY_PREFIX + tag;
    const items = stringArray(await client.sendCommand(["LRANGE", tagKey, "0", "-1"]));
    if (items.length === 0) {
      await client.del(tagKey);
      return 0;
    }

    let deleted = 0;
    for (const key of unique(items.flatMap((item) => {
      const parsed = parseTagEntry(item);
      return parsed && !parsed.expired ? [parsed.cacheKey] : [];
    }))) {
      const meta = await this.getCachedResponseMeta(key);
      if (!meta) continue;
      await this.deleteCachedResponse(key);
      deleted++;
    }

    await client.del(tagKey);
    return deleted;
  }

  public async listByTag(tag: string): Promise<string[]> {
    const client = this.getClient();
    const tagKey = TAG_KEY_PREFIX + tag;
    const items = stringArray(await client.sendCommand(["LRANGE", tagKey, "0", "-1"]));
    if (items.length === 0) return [];

    const result: string[] = [];
    const expiredItems: string[] = [];
    for (const item of items) {
      const parsed = parseTagEntry(item);
      if (!parsed || parsed.expired) {
        expiredItems.push(item);
      } else {
        const meta = await this.getCachedResponseMeta(parsed.cacheKey);
        if (meta) {
          result.push(parsed.cacheKey);
        } else {
          expiredItems.push(item);
        }
      }
    }

    for (const item of expiredItems) {
      await client.sendCommand(["LREM", tagKey, "1", item]);
    }

    const remaining = Number(await client.sendCommand(["LLEN", tagKey]));
    if (remaining === 0) {
      await client.del(tagKey);
    }

    return unique(result);
  }

  public async listByPrefix(prefix: string): Promise<string[]> {
    const client = this.getClient();
    let cursor = "0";
    const keys: string[] = [];

    do {
      const resp = scanResult(await client.sendCommand([
        "SCAN",
        cursor,
        "MATCH",
        `${prefix}*${CACHE_META_SUFFIX}`,
        "COUNT",
        "200",
      ]));
      keys.push(...resp.keys.map(logicalKeyFromMetaKey));
      cursor = resp.cursor;
    } while (cursor !== "0");

    return unique(keys);
  }

  public async cleanExpiredTagIndices(): Promise<number> {
    const client = this.getClient();
    const pattern = `${TAG_KEY_PREFIX}*`;
    let cursor = "0";
    let cleaned = 0;

    do {
      const resp = scanResult(await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "50"]));

      for (const tagKey of resp.keys) {
        const items = stringArray(await client.sendCommand(["LRANGE", tagKey, "0", "-1"]));
        if (items.length === 0) {
          await client.del(tagKey);
          continue;
        }

        for (const item of items) {
          const parsed = parseTagEntry(item);
          if (!parsed || parsed.expired) {
            await client.sendCommand(["LREM", tagKey, "1", item]);
            cleaned++;
          }
        }

        const remaining = Number(await client.sendCommand(["LLEN", tagKey]));
        if (remaining === 0) {
          await client.del(tagKey);
        }
      }

      cursor = resp.cursor;
    } while (cursor !== "0");

    return cleaned;
  }

  public async size(): Promise<number> {
    const count = await this.getClient().sendCommand(["DBSIZE"]);
    return Number(count) || 0;
  }

  private async removeCachedResponseTagIndices(key: string): Promise<void> {
    const client = this.getClient();
    const meta = await this.getCachedResponseMeta(key);
    const tags = meta?.tags;
    if (!tags || tags.length === 0) return;

    for (const tag of tags) {
      const tagKey = TAG_KEY_PREFIX + tag;
      const items = stringArray(await client.sendCommand(["LRANGE", tagKey, "0", "-1"]));
      if (items.length === 0) continue;

      for (const item of items) {
        const parsed = parseTagEntry(item);
        if (parsed && parsed.cacheKey === key) {
          await client.sendCommand(["LREM", tagKey, "1", item]);
        }
      }

      const remaining = Number(await client.sendCommand(["LLEN", tagKey]));
      if (remaining === 0) {
        await client.del(tagKey);
      }
    }
  }

  private resolveTtl(ttl?: number): number {
    const effectiveTtl = ttl ?? this.defaultTtl;
    return effectiveTtl > 0 ? effectiveTtl : this.defaultTtl;
  }

  private getClient(): RedisClientType {
    if (!this.client) {
      throw new Error("RedisCacheStore is not initialized");
    }
    return this.client;
  }
}
