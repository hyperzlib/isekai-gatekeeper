import { describe, it, expect } from "bun:test";
import { CacheStore } from "../../src/lib/cacheStore.ts";
import type { CachedResponse } from "../../src/lib/cacheStore.ts";

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
  it("stores and retrieves entries", () => {
    const store = new CacheStore(100, 1_000_000);
    store.set("/foo", makeResp("hello"));
    const entry = store.get("/foo");
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry!.body)).toBe("hello");
  });

  it("returns null for missing entries", () => {
    const store = new CacheStore(100, 1_000_000);
    expect(store.get("/missing")).toBeNull();
  });

  it("respects max_body_bytes limit", () => {
    const store = new CacheStore(100, 5); // max 5 bytes
    store.set("/big", makeResp("hello world")); // 11 bytes > 5
    expect(store.get("/big")).toBeNull();
  });

  it("evicts LRU entry when max_entries exceeded", () => {
    const store = new CacheStore(2, 1_000_000);
    store.set("/a", makeResp("a"));
    store.set("/b", makeResp("b"));
    store.set("/c", makeResp("c")); // should evict /a
    expect(store.get("/a")).toBeNull();
    expect(store.get("/b")).not.toBeNull();
    expect(store.get("/c")).not.toBeNull();
  });

  it("expires entries by TTL", async () => {
    const store = new CacheStore(100, 1_000_000);
    store.set("/exp", makeResp("expire", 0)); // ttl=0 → immediate expiry
    // Force expiry by setting expiresAt in the past — access internal Map via cast
    const storeAny = store as unknown as { store: Map<string, { resp: CachedResponse; expiresAt: number }> };
    const entry = storeAny.store.get("/exp");
    if (entry) entry.expiresAt = Date.now() - 1;
    expect(store.get("/exp")).toBeNull();
  });

  it("deletes entries by exact key", () => {
    const store = new CacheStore(100, 1_000_000);
    store.set("/del", makeResp("x"));
    store.delete("/del");
    expect(store.get("/del")).toBeNull();
  });

  it("deleteByPrefix removes matching entries and returns count", () => {
    const store = new CacheStore(100, 1_000_000);
    store.set("/wiki/A", makeResp("a"));
    store.set("/wiki/B", makeResp("b"));
    store.set("/other", makeResp("c"));
    const count = store.deleteByPrefix("/wiki/");
    expect(count).toBe(2);
    expect(store.get("/wiki/A")).toBeNull();
    expect(store.get("/wiki/B")).toBeNull();
    expect(store.get("/other")).not.toBeNull();
  });
});
