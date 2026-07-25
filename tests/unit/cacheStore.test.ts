import { describe, it, expect } from "bun:test";
import { MemoryCacheStore } from "../../src/lib/memoryCacheStore.ts";
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

// ── Tag index tests ─────────────────────────────────────────────────────────

describe("CacheStore - Tag index", () => {
  it("listByTag returns keys for a tag", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.set("/wiki/B", makeResp("b"), 60, ["wiki", "zh"]);
    await store.set("/other", makeResp("c"), 60, ["other"]);

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
    await store.set("/expired", makeResp("x"), 60, ["wiki"]);
    await store.set("/fresh", makeResp("y"), 3600, ["wiki"]);

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
    await store.set("/wiki/A", makeResp("a"), 60);
    await store.set("/wiki/B", makeResp("b"), 60);
    await store.set("/other", makeResp("c"), 60);

    const keys = await store.listByPrefix("/wiki/");
    expect(keys.sort()).toEqual(["/wiki/A", "/wiki/B"].sort());

    const allKeys = await store.listByPrefix("/");
    expect(allKeys.length).toBe(3);
  });

  it("listByPrefix returns empty for no match", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/wiki/A", makeResp("a"), 60);
    const keys = await store.listByPrefix("/nonexistent/");
    expect(keys).toEqual([]);
  });

  it("deleteByTag removes cached entries and returns count", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.set("/wiki/B", makeResp("b"), 60, ["wiki", "zh"]);
    await store.set("/other", makeResp("c"), 60, ["other"]);

    const count = await store.deleteByTag("wiki");
    expect(count).toBe(2);

    const entryA = await store.get<CachedResponse>("/wiki/A");
    const entryB = await store.get<CachedResponse>("/wiki/B");
    const entryC = await store.get<CachedResponse>("/other");
    expect(entryA).toBeNull();
    expect(entryB).toBeNull();
    expect(entryC).not.toBeNull();
  });

  it("deleteByTag cleans up tag indices for deleted entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/shared", makeResp("s"), 60, ["wiki", "zh"]);

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
    await store.set("/expired", makeResp("x"), 60, ["wiki"]);
    await store.set("/fresh", makeResp("y"), 3600, ["wiki"]);

    // Force-expire /expired's tag index (but not the store entry)
    const storeAny = store as unknown as { tagIndex: Map<string, Map<string, number>> };
    const tagMap = storeAny.tagIndex.get("wiki")!;
    tagMap.set("/expired", Date.now() - 1);

    const count = await store.deleteByTag("wiki");
    expect(count).toBe(1);

    const freshEntry = await store.get<CachedResponse>("/fresh");
    expect(freshEntry).toBeNull(); // was deleted

    // expired tag-index entry was skipped, so store entry still exists
    const expiredEntry = await store.get<CachedResponse>("/expired");
    expect(expiredEntry).not.toBeNull();
  });

  it("cleanExpiredTagIndices removes expired entries from all tags", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/exp-a", makeResp("a"), 60, ["wiki"]);
    await store.set("/exp-b", makeResp("b"), 60, ["zh"]);
    await store.set("/fresh", makeResp("c"), 3600, ["wiki", "zh"]);

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
    await store.set("/sole", makeResp("s"), 60, ["wiki"]);

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
    await store.set("/shared", makeResp("s"), 60, ["wiki", "zh"]);

    await store.delete("/shared");

    const wikiKeys = await store.listByTag("wiki");
    const zhKeys = await store.listByTag("zh");
    expect(wikiKeys).toEqual([]);
    expect(zhKeys).toEqual([]);
  });

  it("deleteByPrefix cleans tag indices for removed entries", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/wiki/A", makeResp("a"), 60, ["wiki"]);
    await store.set("/wiki/B", makeResp("b"), 60, ["wiki"]);
    await store.set("/other", makeResp("c"), 60, ["wiki"]);

    await store.deleteByPrefix("/wiki/");

    // Only /other should remain in wiki tag
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys).toEqual(["/other"]);
  });

  it("set with empty tags array is a no-op for tag index", async () => {
    const store = new MemoryCacheStore(100, 1_000_000);
    await store.set("/notag", makeResp("x"), 60, []);
    await store.set("/notag2", makeResp("y"), 60);

    const entry = await store.get<CachedResponse>("/notag");
    expect(entry).not.toBeNull();
    // No tags were written, listByTag for anything returns empty
    const keys = await store.listByTag("anything");
    expect(keys).toEqual([]);
  });

  it("LRU eviction also cleans tag indices", async () => {
    const store = new MemoryCacheStore(2, 1_000_000);
    await store.set("/a", makeResp("a"), 60, ["wiki"]);
    await store.set("/b", makeResp("b"), 60, ["wiki"]);
    await store.set("/c", makeResp("c"), 60, ["wiki"]); // evicts /a

    const entryA = await store.get<CachedResponse>("/a");
    expect(entryA).toBeNull();

    // /a should be removed from tag index too
    const wikiKeys = await store.listByTag("wiki");
    expect(wikiKeys.sort()).toEqual(["/b", "/c"].sort());
  });
});
