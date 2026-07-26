import { describe, expect, it } from "bun:test";
import { Context } from "hono";
import { RateLimitService, type RateLimitGroupBy } from "../../src/services/rateLimitService.ts";
import type { AppContext, AppEnv } from "../../src/types/hono.ts";

type StoredValue = {
  value: unknown;
  expiresAt: number;
};

class FakeCacheService {
  public readonly store = new Map<string, StoredValue>();

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  public async set<T>(key: string, value: T, ttlSec = 60): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlSec) * 1000,
    });
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  public async consumeRateLimit(options: {
    key: string;
    windowSec: number;
    maxRequests: number;
    cost: number;
    now: number;
  }) {
    const windowMs = options.windowSec * 1000;
    const resetAt = Math.floor(options.now / windowMs) * windowMs + windowMs;
    const stored = this.store.get(options.key);
    const entry = stored && Date.now() < stored.expiresAt
      ? stored.value as { count: number; resetAt: number; firstLimitedMarked: boolean }
      : null;
    const bucket = !entry || options.now >= entry.resetAt
      ? { count: 0, resetAt, firstLimitedMarked: false }
      : entry;

    bucket.count += options.cost;
    const limited = bucket.count > options.maxRequests;
    const firstLimitedInWindow = limited && !bucket.firstLimitedMarked;
    if (limited) {
      bucket.firstLimitedMarked = true;
    }

    const ttlSec = Math.max(1, Math.ceil((bucket.resetAt - options.now) / 1000));
    this.store.set(options.key, {
      value: bucket,
      expiresAt: Date.now() + ttlSec * 1000,
    });

    return {
      current: bucket.count,
      limited,
      remaining: Math.max(0, options.maxRequests - bucket.count),
      resetAt: bucket.resetAt,
      firstLimitedInWindow,
    };
  }
}

function makeService(fakeCache: FakeCacheService): RateLimitService {
  return new RateLimitService(fakeCache as unknown as any);
}

function makeCtx(overrides: {
  ip?: string;
  path?: string;
  geoip?: unknown;
  validatedClientId?: string | null;
} = {}): AppContext {
  const ip = overrides.ip ?? "1.2.3.4";
  const path = overrides.path ?? "/foo";
  const url = new URL(path, "http://test.com");
  const ctx = new Context<AppEnv>(new Request(url.toString(), {
    headers: { host: "test.com", "x-forwarded-for": ip },
  }), { env: {}, path: url.pathname }) as AppContext;
  ctx.set("requestIp", ip);
  ctx.set("geoip", (overrides.geoip ?? { asn: 64512, countryCode: "cn" }) as AppContext["var"]["geoip"]);
  ctx.set("validatedClientId", "validatedClientId" in overrides ? overrides.validatedClientId : "client-a");
  return ctx;
}

describe("RateLimitService - consume", () => {
  it("counts requests and marks first limit hit only once per window", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    const r1 = await svc.consume({ key: "k1", windowSec: 60, maxRequests: 2 });
    expect(r1.current).toBe(1);
    expect(r1.limited).toBe(false);
    expect(r1.remaining).toBe(1);
    expect(r1.firstLimitedInWindow).toBe(false);

    const r2 = await svc.consume({ key: "k1", windowSec: 60, maxRequests: 2 });
    expect(r2.current).toBe(2);
    expect(r2.limited).toBe(false);
    expect(r2.remaining).toBe(0);
    expect(r2.firstLimitedInWindow).toBe(false);

    const r3 = await svc.consume({ key: "k1", windowSec: 60, maxRequests: 2 });
    expect(r3.current).toBe(3);
    expect(r3.limited).toBe(true);
    expect(r3.remaining).toBe(0);
    expect(r3.firstLimitedInWindow).toBe(true);

    const r4 = await svc.consume({ key: "k1", windowSec: 60, maxRequests: 2 });
    expect(r4.current).toBe(4);
    expect(r4.limited).toBe(true);
    expect(r4.firstLimitedInWindow).toBe(false);
  });

  it("supports cost accumulation", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    const r = await svc.consume({ key: "k-cost", windowSec: 60, maxRequests: 3, cost: 2 });
    expect(r.current).toBe(2);
    expect(r.limited).toBe(false);
    expect(r.remaining).toBe(1);

    const r2 = await svc.consume({ key: "k-cost", windowSec: 60, maxRequests: 3, cost: 2 });
    expect(r2.current).toBe(4);
    expect(r2.limited).toBe(true);
  });

  it("resets stale bucket lazily when current window is over", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);
    const staleKey = "rate_limit:stale:60";

    await cache.set(staleKey, {
      count: 100,
      resetAt: Date.now() - 1000,
      firstLimitedMarked: true,
    }, 60);

    const r = await svc.consume({ key: "stale", windowSec: 60, maxRequests: 10 });
    expect(r.current).toBe(1);
    expect(r.limited).toBe(false);
    expect(r.firstLimitedInWindow).toBe(false);
    expect(r.resetAt).toBeGreaterThan(Date.now());
  });

  it("handles concurrent consume calls through the cache atomic API", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => svc.consume({ key: "parallel", windowSec: 60, maxRequests: 5 })),
    );

    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.filter((r) => r.limited).length).toBe(5);
    expect(results.filter((r) => r.firstLimitedInWindow).length).toBe(1);
  });
});

describe("RateLimitService - wrappers and cleanup", () => {
  it("isLimited returns consume().limited", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    expect(await svc.isLimited({ key: "bool", windowSec: 60, maxRequests: 1 })).toBe(false);
    expect(await svc.isLimited({ key: "bool", windowSec: 60, maxRequests: 1 })).toBe(true);
  });

  it("reset(key, windowSec) clears one window bucket only", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    await svc.consume({ key: "userA", windowSec: 10, maxRequests: 10 });
    await svc.consume({ key: "userA", windowSec: 20, maxRequests: 10 });

    await svc.reset("userA", 10);

    const win10 = await svc.consume({ key: "userA", windowSec: 10, maxRequests: 10 });
    const win20 = await svc.consume({ key: "userA", windowSec: 20, maxRequests: 10 });

    expect(win10.current).toBe(1);
    expect(win20.current).toBe(2);
  });

  it("reset(key) clears all windows for that key", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    await svc.consume({ key: "userB", windowSec: 10, maxRequests: 10 });
    await svc.consume({ key: "userB", windowSec: 30, maxRequests: 10 });

    await svc.reset("userB");

    const after10 = await svc.consume({ key: "userB", windowSec: 10, maxRequests: 10 });
    const after30 = await svc.consume({ key: "userB", windowSec: 30, maxRequests: 10 });

    expect(after10.current).toBe(1);
    expect(after30.current).toBe(1);
  });

  it("clear removes all rate-limit state", async () => {
    const cache = new FakeCacheService();
    const svc = makeService(cache);

    await svc.consume({ key: "a", windowSec: 10, maxRequests: 10 });
    await svc.consume({ key: "b", windowSec: 10, maxRequests: 10 });
    await cache.set("not_rate_limit:key", { ok: true }, 60);

    const deleted = await svc.clear();
    expect(deleted).toBe(2);

    const a = await svc.consume({ key: "a", windowSec: 10, maxRequests: 10 });
    const b = await svc.consume({ key: "b", windowSec: 10, maxRequests: 10 });
    expect(a.current).toBe(1);
    expect(b.current).toBe(1);
  });
});

describe("RateLimitService - buildGroupKey", () => {
  type Case = {
    groupBy: RateLimitGroupBy;
    ctx: AppContext;
    expected: string;
  };

  const cases: Case[] = [
    { groupBy: "ip", ctx: makeCtx(), expected: "ip:1.2.3.4" },
    { groupBy: "asn", ctx: makeCtx(), expected: "asn:64512" },
    { groupBy: "country", ctx: makeCtx(), expected: "country:CN" },
    { groupBy: "ip+path", ctx: makeCtx(), expected: "ip:1.2.3.4:path:/foo" },
    { groupBy: "asn+path", ctx: makeCtx(), expected: "asn:64512:path:/foo" },
    { groupBy: "country+path", ctx: makeCtx(), expected: "country:CN:path:/foo" },
    { groupBy: "client_id", ctx: makeCtx(), expected: "client_id:client-a" },
    { groupBy: "client_id+path", ctx: makeCtx(), expected: "client_id:client-a:path:/foo" },
    {
      groupBy: "asn",
      ctx: makeCtx({ geoip: { countryCode: "JP" } as any }),
      expected: "ip:1.2.3.4",
    },
    {
      groupBy: "country",
      ctx: makeCtx({ geoip: { asn: 64512 } as any }),
      expected: "ip:1.2.3.4",
    },
    {
      groupBy: "country",
      ctx: makeCtx({ geoip: { country_code: "us" } as any }),
      expected: "country:US",
    },
    {
      groupBy: "client_id+path",
      ctx: makeCtx({ validatedClientId: null }),
      expected: "ip:1.2.3.4:path:/foo",
    },
  ];

  it.each(cases)("builds key for $groupBy", ({ groupBy, ctx, expected }) => {
    const svc = makeService(new FakeCacheService());
    expect(svc.buildGroupKey(ctx, groupBy)).toBe(expected);
  });
});
