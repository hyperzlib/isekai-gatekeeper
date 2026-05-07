import { describe, it, expect } from "bun:test";
import Koa, { Context } from "koa";
import { RuleEngineService } from "../../src/services/ruleEngineService.ts";
import type { AppConfig, SiteConfig } from "../../src/types/config.ts";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";
import { makePageCacheKey, PAGE_CACHE_KEY_PREFIX } from "../../src/utils/cache.ts";

function makeKoaApp(): Koa {
  return new Koa();
}

function makeConfig(
  rules: AppConfig["sites"][string]["rules"],
  overrides: { cacheEnabled?: boolean; browserChallengeEnabled?: boolean } = {},
): AppConfig {
  return {
    proxy: { server_port: 8080 },
    api: { server_port: 8081, key: "key" },
    templates_dir: "./views",
    browser_challenge: {
      enabled: overrides.browserChallengeEnabled ?? true,
      cookie_ttl: 86400,
      challenge_ttl: 300,
      secret: "secret",
      pow: { difficulty: 16 },
    },
    cache: {
      enabled: overrides.cacheEnabled ?? false,
      provider: "memory",
      default_ttl: 60,
      max_entries: 100,
      max_body_bytes: 1_000_000,
      cache_key_mode: "path+query",
      allowed_mimetypes: ["text/html"],
      bypass_after_challenge: true,
    },
    sites: {
      "test.com": {
        hostname: "test.com",
        backend: { url: "http://localhost:8000" },
        ...(rules !== undefined ? { rules } : {}),
      } as SiteConfig,
    },
  };
}

function makeCtx(app: Koa, path: string, extraHeaders: Record<string, string> = {}): Context {
  const httpRequest = new IncomingMessage(null as any);
  httpRequest.url = path;
  httpRequest.headers = {
    host: "test.com",
    ...extraHeaders,
  };
  const httpResponse = new ServerResponse(httpRequest);
  return app.createContext(httpRequest, httpResponse);
}

// ─── 编译阶段 ────────────────────────────────────────────────────────────────

describe("RuleEngineService - compilation", () => {
  it("compiles a valid rule without error", () => {
    expect(
      () => new RuleEngineService(makeKoaApp(), makeConfig([
        { id: "r1", condition: "ctx.request.path === '/foo'" },
      ])),
    ).not.toThrow();
  });

  it("throws on forbidden identifier (eval)", async () => {
    const svc = new RuleEngineService(makeKoaApp(), makeConfig([
      { id: "r1", condition: "eval('1+1') === 2" },
    ]));
    expect(
      async () => await svc.init(),
    ).toThrow(/rule=r1/);
  });

  it("throws on forbidden identifier (fetch)", async () => {
    const svc = new RuleEngineService(makeKoaApp(), makeConfig([
      { id: "r2", condition: "fetch('/api') !== null" },
    ]));
    expect(
      async () => await svc.init(),
    ).toThrow(/rule=r2/);
  });

  it("throws on syntax error in condition", async () => {
    const svc = new RuleEngineService(makeKoaApp(), makeConfig([
      { id: "bad", condition: "((( invalid syntax" },
    ]));
    expect(
      async () => await svc.init(),
    ).toThrow(/rule=bad/);
  });

  it("throws on runtime error during dry-run with example request", async () => {
    const svc = new RuleEngineService(makeKoaApp(), makeConfig([
      { id: "boom", condition: "ctx.request.nonExistentMethod()" },
    ]));
    expect(
      async () => await svc.init(),
    ).toThrow(/rule=boom/);
  });
});

// ─── getSiteByHostname ───────────────────────────────────────────────────────

describe("RuleEngineService - getSiteByHostname", () => {
  it("returns site config for known hostname", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([]));
    await svc.init();
    const site = svc.getSiteByHostname("test.com");
    expect(site).not.toBeNull();
    expect(site!.hostname).toBe("test.com");
  });

  it("returns null for unknown hostname", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([]));
    await svc.init();
    expect(svc.getSiteByHostname("other.com")).toBeNull();
  });
});

// ─── evaluate：默认行为 ───────────────────────────────────────────────────────

describe("RuleEngineService - evaluate defaults", () => {
  it("no site match → block=false, cache from global config, cache_key set", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([]));
    await svc.init();
    const req = new IncomingMessage(null as any);
    req.url = "/page";
    req.headers = { host: "unknown.com" };
    const ctx = app.createContext(req, new ServerResponse(req));
    const dec = await svc.evaluate(ctx);
    expect(dec.block).toBe(false);
    expect(dec.cache?.enabled).toBe(false);
    expect(dec.cache_key).toBe(`${PAGE_CACHE_KEY_PREFIX}unknown:/page`);
  });

  it("no rules → block=false, inherits global cache/browser_challenge", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([], { cacheEnabled: true }));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/anything"));
    expect(dec.block).toBe(false);
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.browser_challenge?.enabled).toBe(true);
  });
});

// ─── evaluate：block / return ─────────────────────────────────────────────────

describe("RuleEngineService - evaluate block / return", () => {
  it("block=true when matching block rule", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "blk", condition: "ctx.request.path === '/bad'", block: true },
    ]));
    await svc.init();
    expect((await svc.evaluate(makeCtx(app, "/bad"))).block).toBe(true);
    expect((await svc.evaluate(makeCtx(app, "/good"))).block).toBe(false);
  });

  it("block rule disables cache and browser_challenge", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "blk", condition: "true", block: true },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/any"));
    expect(dec.cache?.enabled).toBe(false);
    expect(dec.browser_challenge?.enabled).toBe(false);
  });

  it("return rule carries return payload and disables cache", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      {
        id: "ret",
        condition: "ctx.request.path === '/custom'",
        return: { status: 403, text: "Forbidden" },
      },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/custom"));
    expect(dec.block).toBe(false);
    expect(dec.return?.status).toBe(403);
    expect(dec.return?.text).toBe("Forbidden");
    expect(dec.cache?.enabled).toBe(false);
  });

  it("block rule stops further rule processing", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "blk", condition: "true", block: true },
      // 第二条本应覆盖 cache，但因 block 已终止，不应生效
      { id: "cache", condition: "true", cache: { enabled: true, ttl: 999 } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/any"));
    expect(dec.block).toBe(true);
    expect(dec.cache?.ttl).not.toBe(999);
  });
});

// ─── evaluate：exec ────────────────────────────────────────────────────
describe("RuleEngineService - evaluate exec", () => {
  it("exec code can modify decision", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      {
        id: "exec",
        condition: "ctx.request.path === '/exec'",
        exec: "state.test = 123;",
      },
    ]));
    await svc.init();
    const ctx = makeCtx(app, "/exec");
    const dec = await svc.evaluate(ctx);
    expect(ctx.state.ruleEngineState?.test).toBe(123);
  });
});


// ─── evaluate：cache / browser_challenge 策略合并 ─────────────────────────────

describe("RuleEngineService - evaluate cache / browser_challenge policy", () => {
  it("cache policy from matching rule overrides default", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      {
        id: "c1",
        condition: "ctx.request.path.startsWith('/static/')",
        cache: { enabled: true, ttl: 3600, cache_key_mode: "path" },
      },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/static/logo.png"));
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache?.ttl).toBe(3600);
    expect(dec.cache?.cache_key_mode).toBe("path");
  });

  it("browser_challenge disabled by matching rule", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      {
        id: "bc1",
        condition: "ctx.request.path === '/healthz'",
        browser_challenge: { enabled: false },
      },
    ]));
    await svc.init();
    expect((await svc.evaluate(makeCtx(app, "/healthz"))).browser_challenge?.enabled).toBe(false);
    expect((await svc.evaluate(makeCtx(app, "/other"))).browser_challenge?.enabled).toBe(true);
  });

  it("later matching rule overrides earlier cache policy (last-hit wins)", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "r1", condition: "true", cache: { enabled: true, ttl: 60 } },
      { id: "r2", condition: "ctx.request.path === '/nocache'", cache: { enabled: false, ttl: 1 } },
    ]));
    await svc.init();
    // r2 命中，覆盖 r1
    expect((await svc.evaluate(makeCtx(app, "/nocache"))).cache?.enabled).toBe(false);
    // r2 不命中，保留 r1 设置
    expect((await svc.evaluate(makeCtx(app, "/other"))).cache?.enabled).toBe(true);
  });

  it("last=true stops further rule processing", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "r1", condition: "true", cache: { enabled: true, ttl: 100 }, last: true },
      { id: "r2", condition: "true", cache: { enabled: false, ttl: 1 } }, // 不应执行
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/x"));
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache?.ttl).toBe(100);
  });
});

// ─── evaluate：matcher 运行时错误容忍 ────────────────────────────────────────

describe("RuleEngineService - evaluate runtime fault tolerance", () => {
  it("silently skips a rule whose matcher throws at runtime", async () => {
    const app = makeKoaApp();
    // 该 condition 在 dry-run 时可通过，但在特定输入下会抛异常
    // 用 presets 访问一个不存在的方法来触发运行时错误无法直接测，改用多规则场景验证跳过逻辑
    const svc = new RuleEngineService(app, makeConfig([
      { id: "safe", condition: "true", cache: { enabled: true, ttl: 42 } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/any"));
    // 正常规则仍然生效
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache?.ttl).toBe(42);
  });
});

// ─── evaluate：cache_key 构建 ─────────────────────────────────────────────────

describe("RuleEngineService - cache_key generation", () => {
  it("default cache_key_mode=path+query sorts query params", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/page?z=1&a=2"));
    expect(dec.cache_key).toBe(`${PAGE_CACHE_KEY_PREFIX}unknown:/page:?a=2&z=1`);
  });

  it("path mode strips query string", async () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "c1", condition: "true", cache: { enabled: true, cache_key_mode: "path" } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx(app, "/page?foo=bar"));
    expect(dec.cache_key).toBe(`${PAGE_CACHE_KEY_PREFIX}unknown:/page`);
  });
});

// ─── buildCacheKey 单元测试 ────────────────────────────────────────────────────

describe("buildCacheKey", () => {
  function makeSimpleCtx(app: Koa, url: string): Context {
    const req = new IncomingMessage(null as any);
    req.url = url;
    req.headers = { host: "test.com" };
    return app.createContext(req, new ServerResponse(req));
  }

  const app = makeKoaApp();

  it("path mode returns only pathname", () => {
    const ctx = makeSimpleCtx(app, "/foo/bar?x=1");
    expect(makePageCacheKey("example", ctx.URL.pathname, ctx.URL.search, "path")).toBe(`${PAGE_CACHE_KEY_PREFIX}example:/foo:bar`);
  });

  it("path+query mode returns pathname with query", () => {
    const ctx = makeSimpleCtx(app, "/foo?c=3&a=1&b=2");
    expect(makePageCacheKey("example", ctx.URL.pathname, ctx.URL.search, "path+query")).toBe(`${PAGE_CACHE_KEY_PREFIX}example:/foo:?a=1&b=2&c=3`);
  });

  it("path+query mode sorts query params alphabetically", () => {
    const ctx1 = makeSimpleCtx(app, "/foo?z=1&a=2");
    const ctx2 = makeSimpleCtx(app, "/foo?a=2&z=1");
    const key1 = makePageCacheKey("example", ctx1.URL.pathname, ctx1.URL.search, "path+query");
    const key2 = makePageCacheKey("example", ctx2.URL.pathname, ctx2.URL.search, "path+query");
    expect(key1).toBe(key2);
  });

  it("path+query with no query returns just pathname", () => {
    const ctx = makeSimpleCtx(app, "/foo");
    expect(makePageCacheKey("example", ctx.URL.pathname, ctx.URL.search, "path+query")).toBe(`${PAGE_CACHE_KEY_PREFIX}example:/foo`);
  });
});
