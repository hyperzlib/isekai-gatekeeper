import { describe, it, expect } from "bun:test";
import { MemoryCacheStore } from "../../src/lib/memoryCacheStore.ts";
import { BunRedisCacheStore } from "../../src/lib/bunRedisCacheStore.ts";
import { RedisCacheStore } from "../../src/lib/redisCacheStore.ts";
import { CachedResponse, ICacheStore } from "../../src/types/cache.ts";

function makeResp(body: string, ttl = 60): CachedResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from(body),
    cachedAt: Date.now(),
    ttl,
  };
}

function expectBody(body: Buffer | undefined, expected: string | number[]): void {
  expect(body).not.toBeUndefined();
  if (typeof expected === "string") {
    expect(body!.toString("utf-8")).toBe(expected);
  } else {
    expect(Array.from(body!)).toEqual(expected);
  }
}

const redisTestUrl = Bun.env["ISEKAI_TEST_REDIS_URL"];
const describeRedis = redisTestUrl ? describe : describe.skip;

function redisKeyPrefix(): string {
  return `test:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

describe("CacheStore", () => {
  it("stores and retrieves entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/foo", makeResp("hello"));
    const entry = await store.get<CachedResponse>("/foo");
    expect(entry).not.toBeNull();
    expectBody(entry!.body, "hello");
  });

  it("returns null for missing entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    const entry = await store.get<CachedResponse>("/missing");
    expect(entry).toBeNull();
  });

  it("respects max_body_bytes limit", async () => {
    const store = new MemoryCacheStore(100, 5); // max 5 bytes
    await store.set("/big", makeResp("hello world")); // 11 bytes > 5
    const entry = await store.get<CachedResponse>("/big");
    expect(entry).toBeNull();
  });

  it("evicts LRU entry when max_entries exceeded", async () => {
    const store = new MemoryCacheStore(2, 1_000_000);
    await store.set("/a", makeResp("a"));
    await store.set("/b", makeResp("b"));
    await store.set("/c", makeResp("c")); // should evict /a
    const entryA = await store.get<CachedResponse>("/a");
    const entryB = await store.get<CachedResponse>("/b");
    const entryC = await store.get<CachedResponse>("/c");
    expect(entryA).toBeNull();
    expect(entryB).not.toBeNull();
    expect(entryC).not.toBeNull();
  });

  it("expires entries by TTL", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/exp", makeResp("expire", 0)); // ttl=0 → immediate expiry
    // Force expiry by setting expiresAt in the past — access internal Map via cast
    const storeAny = store as unknown as { store: Map<string, { resp: CachedResponse; expiresAt: number }> };
    const entry = storeAny.store.get("/exp");
    if (entry) entry.expiresAt = Date.now() - 1;
    const expiredEntry = await store.get<CachedResponse>("/exp");
    expect(expiredEntry).toBeNull();
  });

  it("deletes entries by exact key", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/del", makeResp("x"));
    await store.delete("/del");
    const entry = await store.get<CachedResponse>("/del");
    expect(entry).toBeNull();
  });

  it("deleteByPrefix removes matching entries and returns count", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/wiki/A", makeResp("a"));
    await store.set("/wiki/B", makeResp("b"));
    await store.set("/other", makeResp("c"));
    const count = await store.deleteByPrefix("/wiki/");
    expect(count).toBe(2);
    const entryA = await store.get<CachedResponse>("/wiki/A");
    const entryB = await store.get<CachedResponse>("/wiki/B");
    const entryC = await store.get<CachedResponse>("/other");
    expect(entryA).toBeNull();
    expect(entryB).toBeNull();
    expect(entryC).not.toBeNull();
  });
});

describe("CacheStore - CachedResponse API", () => {
  it("stores response meta separately from body at the API level", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/page", makeResp("hello"), 60, ["page"]);

    const meta = await store.getCachedResponseMeta("/page");
    expect(meta).toEqual({
      status: 200,
      headers: { "content-type": "text/html" },
      cachedAt: expect.any(Number),
      ttl: 60,
      tags: ["page"],
    });
    expect("body" in meta!).toBe(false);

    const entry = await store.getCachedResponse("/page");
    expectBody(entry?.body, "hello");
  });

  it("preserves cached response body bytes", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    const body = Buffer.from([0, 0xff, 0x61, 0xc3, 0x28]);

    await store.setCachedResponse("/binary-page", {
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      cachedAt: Date.now(),
      ttl: 60,
    }, 60);

    const entry = await store.getCachedResponse("/binary-page");
    expectBody(entry?.body, [0, 0xff, 0x61, 0xc3, 0x28]);
  });

  it("deleteCachedResponse removes response and tag indices", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/page", makeResp("hello"), 60, ["page"]);

    await store.deleteCachedResponse("/page");

    expect(await store.getCachedResponse("/page")).toBeNull();
    expect(await store.listByTag("page")).toEqual([]);
  });

  it("overwriting a response removes stale tag indices", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/page", makeResp("hello"), 60, ["old"]);
    await store.setCachedResponse("/page", makeResp("updated"), 60, ["new"]);

    expect(await store.listByTag("old")).toEqual([]);
    expect(await store.listByTag("new")).toEqual(["/page"]);
  });

  it("does not scan tag indices when cached response has no tags", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/page", makeResp("hello"), 60);

    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    storeAny.tagIndex.set("orphan", new Map([["/page", Date.now() + 60_000]]));

    await store.deleteCachedResponse("/page");

    expect(await store.listByTag("orphan")).toEqual(["/page"]);
  });
});

// ── Tag index tests ─────────────────────────────────────────────────────────

describe("CacheStore - Tag index", () => {
  it("listByTag returns keys for a tag", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.setCachedResponse("/wiki/B", makeResp("b"), 60, ["wiki", "zh"]);
    await store.setCachedResponse("/other", makeResp("c"), 60, ["other"]);

    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys.sort()).toEqual(["/wiki/A", "/wiki/B"].sort());

    const zhKeys = await store.listByTag("zh");
    expect(zhKeys).toEqual(["/wiki/B"]);

    const otherKeys = await store.listByTag("other");
    expect(otherKeys).toEqual(["/other"]);
  });

  it("listByTag excludes expired entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    // Set one entry with a very short TTL that we'll force-expire
    await store.setCachedResponse("/expired", makeResp("x"), 60, ["wiki"]);
    await store.setCachedResponse("/fresh", makeResp("y"), 3600, ["wiki"]);

    // Force /expired's tag index to be expired
    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    const tagMap = storeAny.tagIndex.get("wiki")!;
    tagMap.set("/expired", Date.now() - 1);

    const keys = await store.listByTag("wiki");
    expect(keys).toEqual(["/fresh"]);
  });

  it("listByTag returns empty array for unknown tag", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    const keys = await store.listByTag("nonexistent");
    expect(keys).toEqual([]);
  });

  it("listByPrefix returns matching keys", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/wiki/A", makeResp("a"), 60);
    await store.setCachedResponse("/wiki/B", makeResp("b"), 60);
    await store.setCachedResponse("/other", makeResp("c"), 60);

    const keys = await store.listByPrefix("/wiki/");
    expect(keys.sort()).toEqual(["/wiki/A", "/wiki/B"].sort());

    const allKeys = await store.listByPrefix("/");
    expect(allKeys.length).toBe(3);
  });

  it("listByPrefix returns empty for no match", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/wiki/A", makeResp("a"), 60);
    const keys = await store.listByPrefix("/nonexistent/");
    expect(keys).toEqual([]);
  });

  it("deleteByTag removes cached entries and returns count", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.setCachedResponse("/wiki/B", makeResp("b"), 60, ["wiki", "zh"]);
    await store.setCachedResponse("/other", makeResp("c"), 60, ["other"]);

    const count = await store.deleteByTag("wiki");
    expect(count).toBe(2);

    const entryA = await store.getCachedResponse("/wiki/A");
    const entryB = await store.getCachedResponse("/wiki/B");
    const entryC = await store.getCachedResponse("/other");
    expect(entryA).toBeNull();
    expect(entryB).toBeNull();
    expect(entryC).not.toBeNull();
  });

  it("deleteByTag cleans up tag indices for deleted entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/shared", makeResp("s"), 60, ["wiki", "zh"]);

    await store.deleteByTag("wiki");

    // /shared was deleted, so it should no longer appear in "zh" either
    const zhKeys = await store.listByTag("zh");
    expect(zhKeys).toEqual([]);

    // "wiki" tag itself should be removed
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys).toEqual([]);
  });

  it("deleteByTag returns 0 for unknown tag", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    const count = await store.deleteByTag("nonexistent");
    expect(count).toBe(0);
  });

  it("deleteByTag skips expired entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/expired", makeResp("x"), 60, ["wiki"]);
    await store.setCachedResponse("/fresh", makeResp("y"), 3600, ["wiki"]);

    // Force-expire /expired's tag index (but not the store entry)
    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    const tagMap = storeAny.tagIndex.get("wiki")!;
    tagMap.set("/expired", Date.now() - 1);

    const count = await store.deleteByTag("wiki");
    expect(count).toBe(1);

    const freshEntry = await store.getCachedResponse("/fresh");
    expect(freshEntry).toBeNull(); // was deleted

    // expired tag-index entry was skipped, so store entry still exists
    const expiredEntry = await store.getCachedResponse("/expired");
    expect(expiredEntry).not.toBeNull();
  });

  it("cleanExpiredTagIndices removes expired entries from all tags", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/exp-a", makeResp("a"), 60, ["wiki"]);
    await store.setCachedResponse("/exp-b", makeResp("b"), 60, ["zh"]);
    await store.setCachedResponse("/fresh", makeResp("c"), 3600, ["wiki", "zh"]);

    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    storeAny.tagIndex.get("wiki")!.set("/exp-a", Date.now() - 1);
    storeAny.tagIndex.get("zh")!.set("/exp-b", Date.now() - 1);

    const cleaned = await store.cleanExpiredTagIndices();
    expect(cleaned).toBe(2);

    // Expired entries removed from indices
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys).toEqual(["/fresh"]);

    const zhKeys = await store.listByTag("zh");
    expect(zhKeys).toEqual(["/fresh"]);
  });

  it("cleanExpiredTagIndices removes empty tag keys", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/sole", makeResp("s"), 60, ["wiki"]);

    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    storeAny.tagIndex.get("wiki")!.set("/sole", Date.now() - 1);

    await store.cleanExpiredTagIndices();

    // Both entry and tag should be gone
    const keys = await store.listByTag("wiki");
    expect(keys).toEqual([]);
    expect(storeAny.tagIndex.has("wiki")).toBe(false);
  });

  it("delete removes entry from tag indices", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/shared", makeResp("s"), 60, ["wiki", "zh"]);

    await store.deleteCachedResponse("/shared");

    const wikiKeys = await store.listByTag("wiki");
    const zhKeys = await store.listByTag("zh");
    expect(wikiKeys).toEqual([]);
    expect(zhKeys).toEqual([]);
  });

  it("deleteByPrefix cleans tag indices for removed entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.setCachedResponse("/wiki/B", makeResp("b"), 60, ["wiki"]);
    await store.setCachedResponse("/other", makeResp("c"), 60, ["wiki"]);

    await store.deleteByPrefix("/wiki/");

    // Only /other should remain in wiki tag
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys).toEqual(["/other"]);
  });

  it("set with empty tags array is a no-op for tag index", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.setCachedResponse("/notag", makeResp("x"), 60, []);
    await store.setCachedResponse("/notag2", makeResp("y"), 60);

    const entry = await store.getCachedResponse("/notag");
    expect(entry).not.toBeNull();
    // No tags were written, listByTag for anything returns empty
    const keys = await store.listByTag("anything");
    expect(keys).toEqual([]);
  });

  it("LRU eviction also cleans tag indices", async () => {
    const store = new MemoryCacheStore(2, 1_000_000);
    await store.setCachedResponse("/a", makeResp("a"), 60, ["wiki"]);
    await store.setCachedResponse("/b", makeResp("b"), 60, ["wiki"]);
    await store.setCachedResponse("/c", makeResp("c"), 60, ["wiki"]); // evicts /a

    const entryA = await store.getCachedResponse("/a");
    expect(entryA).toBeNull();

    // /a should be removed from tag index too
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys.sort()).toEqual(["/b", "/c"].sort());
  });
});

describeRedis("BunRedisCacheStore - optional Redis integration", () => {
  async function makeRedisStore(): Promise<{ store: ICacheStore; prefix: string }> {
    const store = new BunRedisCacheStore(redisTestUrl!, 1_000_000, 60);
    await store.init();
    return { store, prefix: redisKeyPrefix() };
  }

  it("stores generic values without using response cache keys", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}generic`;

    await store.set(key, { ok: true }, 60);

    expect(await store.get<{ ok: boolean }>(key)).toEqual({ ok: true });
    expect(await store.getCachedResponseMeta(key)).toBeNull();

    await store.delete(key);
    expect(await store.get<{ ok: boolean }>(key)).toBeNull();
  });

  it("stores cached response meta and body under the logical key", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}page`;

    await store.setCachedResponse(key, makeResp("hello"), 60, [`${prefix}tag`]);

    const meta = await store.getCachedResponseMeta(key);
    expect(meta).toEqual({
      status: 200,
      headers: { "content-type": "text/html" },
      cachedAt: expect.any(Number),
      ttl: 60,
      tags: [`${prefix}tag`],
    });
    expect("body" in meta!).toBe(false);

    const cached = await store.getCachedResponse(key);
    expectBody(cached?.body, "hello");
    expect(await store.listByPrefix(prefix)).toEqual([key]);

    await store.deleteCachedResponse(key);
    expect(await store.getCachedResponse(key)).toBeNull();
    expect(await store.listByTag(`${prefix}tag`)).toEqual([]);
  });

  it("cleans stale tag indices from previous cached response tags", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}page`;

    await store.setCachedResponse(key, makeResp("old"), 60, [`${prefix}old`]);
    await store.setCachedResponse(key, makeResp("new"), 60, [`${prefix}new`]);

    expect(await store.listByTag(`${prefix}old`)).toEqual([]);
    expect(await store.listByTag(`${prefix}new`)).toEqual([key]);

    await store.deleteByTag(`${prefix}new`);
    expect(await store.getCachedResponse(key)).toBeNull();
  });

  it("deletes cached responses by logical prefix without exposing meta/body keys", async () => {
    const { store, prefix } = await makeRedisStore();
    const a = `${prefix}wiki/A`;
    const b = `${prefix}wiki/B`;
    const other = `${prefix}other`;

    await store.setCachedResponse(a, makeResp("a"), 60, [`${prefix}wiki`]);
    await store.setCachedResponse(b, makeResp("b"), 60, [`${prefix}wiki`]);
    await store.setCachedResponse(other, makeResp("other"), 60, [`${prefix}other`]);

    expect((await store.listByPrefix(`${prefix}wiki/`)).sort()).toEqual([a, b].sort());
    const deleted = await store.deleteByPrefix(`${prefix}wiki/`);

    expect(deleted).toBe(2);
    expect(await store.getCachedResponse(a)).toBeNull();
    expect(await store.getCachedResponse(b)).toBeNull();
    expect(await store.getCachedResponse(other)).not.toBeNull();
    expect(await store.listByTag(`${prefix}wiki`)).toEqual([]);

    await store.deleteByPrefix(prefix);
  });

  it("consumes rate limits atomically through Redis", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}rate`;
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consumeRateLimit({
        key,
        windowSec: 60,
        maxRequests: 5,
        cost: 1,
        now,
      })),
    );

    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.filter((r) => r.limited).length).toBe(5);
    expect(results.filter((r) => r.firstLimitedInWindow).length).toBe(1);

    await store.delete(key);
  });
});

describeRedis("RedisCacheStore - optional Redis integration", () => {
  async function makeRedisStore(): Promise<{ store: ICacheStore; prefix: string }> {
    const store = new RedisCacheStore(redisTestUrl!, 1_000_000, 60);
    await store.init();
    return { store, prefix: redisKeyPrefix() };
  }

  it("stores generic values without using response cache keys", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}generic`;

    await store.set(key, { ok: true }, 60);

    expect(await store.get<{ ok: boolean }>(key)).toEqual({ ok: true });
    expect(await store.getCachedResponseMeta(key)).toBeNull();

    await store.delete(key);
    expect(await store.get<{ ok: boolean }>(key)).toBeNull();
  });

  it("stores cached response meta and body under the logical key", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}page`;

    await store.setCachedResponse(key, makeResp("hello"), 60, [`${prefix}tag`]);

    const meta = await store.getCachedResponseMeta(key);
    expect(meta).toEqual({
      status: 200,
      headers: { "content-type": "text/html" },
      cachedAt: expect.any(Number),
      ttl: 60,
      tags: [`${prefix}tag`],
    });
    expect("body" in meta!).toBe(false);

    const cached = await store.getCachedResponse(key);
    expectBody(cached?.body, "hello");
    expect(await store.listByPrefix(prefix)).toEqual([key]);

    await store.deleteCachedResponse(key);
    expect(await store.getCachedResponse(key)).toBeNull();
    expect(await store.listByTag(`${prefix}tag`)).toEqual([]);
  });

  it("cleans stale tag indices from previous cached response tags", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}page`;

    await store.setCachedResponse(key, makeResp("old"), 60, [`${prefix}old`]);
    await store.setCachedResponse(key, makeResp("new"), 60, [`${prefix}new`]);

    expect(await store.listByTag(`${prefix}old`)).toEqual([]);
    expect(await store.listByTag(`${prefix}new`)).toEqual([key]);

    await store.deleteByTag(`${prefix}new`);
    expect(await store.getCachedResponse(key)).toBeNull();
  });

  it("deletes cached responses by logical prefix without exposing meta/body keys", async () => {
    const { store, prefix } = await makeRedisStore();
    const a = `${prefix}wiki/A`;
    const b = `${prefix}wiki/B`;
    const other = `${prefix}other`;

    await store.setCachedResponse(a, makeResp("a"), 60, [`${prefix}wiki`]);
    await store.setCachedResponse(b, makeResp("b"), 60, [`${prefix}wiki`]);
    await store.setCachedResponse(other, makeResp("other"), 60, [`${prefix}other`]);

    expect((await store.listByPrefix(`${prefix}wiki/`)).sort()).toEqual([a, b].sort());
    const deleted = await store.deleteByPrefix(`${prefix}wiki/`);

    expect(deleted).toBe(2);
    expect(await store.getCachedResponse(a)).toBeNull();
    expect(await store.getCachedResponse(b)).toBeNull();
    expect(await store.getCachedResponse(other)).not.toBeNull();
    expect(await store.listByTag(`${prefix}wiki`)).toEqual([]);

    await store.deleteByPrefix(prefix);
  });

  it("consumes rate limits atomically through Redis", async () => {
    const { store, prefix } = await makeRedisStore();
    const key = `${prefix}rate`;
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consumeRateLimit({
        key,
        windowSec: 60,
        maxRequests: 5,
        cost: 1,
        now,
      })),
    );

    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.filter((r) => r.limited).length).toBe(5);
    expect(results.filter((r) => r.firstLimitedInWindow).length).toBe(1);

    await store.delete(key);
  });
});
