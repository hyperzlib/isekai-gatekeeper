import { describe, it, expect } from "bun:test";
import { MemoryCacheStore } from "../../src/services/cacheStores/memoryCacheStore.ts";
import { CachedResponse } from "../../src/types/cache.ts";

function makeResp(body: string, ttl = 60): CachedResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: new TextEncoder().encode(body),
    cachedAt: Date.now(),
    ttl,
  };
}

describe("CacheStore", () => {
  it("stores and retrieves entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/foo", makeResp("hello"));
    const entry = await store.get<CachedResponse>("/foo");
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry!.body)).toBe("hello");
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
