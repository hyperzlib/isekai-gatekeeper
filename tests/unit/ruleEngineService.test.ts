import { describe, it, expect } from "bun:test";
import Koa, { Context } from "koa";
import { RuleEngineService } from "../../src/services/ruleEngineService.ts";
import type { AppConfig, SiteConfig } from "../../src/types/config.ts";
import type { RuleConfig, RuleInput, RuleTraceEvent } from "../../src/types/rule.ts";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";
import { makePageCacheKey, PAGE_CACHE_KEY_PREFIX } from "../../src/utils/cache.ts";

function makeConfig(
  rules: RuleConfig[],
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
        rules,
      } as SiteConfig,
    },
  };
}

function makeCtx(path: string, extraHeaders: Record<string, string> = {}): Context {
  const app = new Koa();
  const httpRequest = new IncomingMessage(null as any);
  httpRequest.url = path;
  httpRequest.headers = { host: "test.com", ...extraHeaders };
  const httpResponse = new ServerResponse(httpRequest);
  return app.createContext(httpRequest, httpResponse);
}

function trueCond(_input: RuleInput): boolean { return true; }
function falseCond(_input: RuleInput): boolean { return false; }
function pathCond(path: string): RuleConfig["condition"] {
  return ({ ctx }: RuleInput) => ctx.request.path === path;
}
function noop() {}

// ─── getSiteByHostname ───────────────────────────────────────────────────────

describe("RuleEngineService - getSiteByHostname", () => {
  it("returns site config for known hostname", async () => {
    const svc = new RuleEngineService(makeConfig([]));
    await svc.init();
    const site = svc.getSiteByHostname("test.com");
    expect(site).not.toBeNull();
    expect(site!.hostname).toBe("test.com");
  });

  it("returns null for unknown hostname", async () => {
    const svc = new RuleEngineService(makeConfig([]));
    await svc.init();
    expect(svc.getSiteByHostname("other.com")).toBeNull();
  });

  it("prefers bare hostnames but falls back to explicit standard ports", async () => {
    const cfg = makeConfig([]);
    cfg.sites["test.com"]!.hostname = ["test.com:80", "fallback.test"];

    const svc = new RuleEngineService(cfg);
    await svc.init();

    expect(svc.getSiteByHostname("test.com")?.hostname).toEqual(["test.com:80", "fallback.test"]);
    expect(svc.getSiteByHostname("test.com:80")?.hostname).toEqual(["test.com:80", "fallback.test"]);
  });
});

// ─── evaluate：默认行为 ───────────────────────────────────────────────────────

describe("RuleEngineService - evaluate defaults", () => {
  it("no site match → block=false, cache from global config", async () => {
    const svc = new RuleEngineService(makeConfig([]));
    await svc.init();
    const req = new IncomingMessage(null as any);
    req.url = "/page";
    req.headers = { host: "unknown.com" };
    const ctx = new Koa().createContext(req, new ServerResponse(req));
    const dec = await svc.evaluate(ctx);
    expect(dec.block).toBe(false);
    expect(dec.cache?.enabled).toBe(false);
    expect(dec.cache_key).toBe(`${PAGE_CACHE_KEY_PREFIX}unknown:/page`);
  });

  it("no rules → block=false, inherits global config", async () => {
    const svc = new RuleEngineService(makeConfig([], { cacheEnabled: true }));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/anything"));
    expect(dec.block).toBe(false);
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.browser_challenge?.enabled).toBe(true);
  });

  it("does not fall back to the bare hostname for non-standard ports", async () => {
    const svc = new RuleEngineService(makeConfig([], { cacheEnabled: true }));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/anything", { host: "test.com:8080" }));
    expect(dec.block).toBe(false);
    expect(dec.cache_key).toBe(`${PAGE_CACHE_KEY_PREFIX}unknown:/anything`);
  });
});

// ─── evaluate：block / return ─────────────────────────────────────────────────

describe("RuleEngineService - evaluate block / return", () => {
  it("block=true when matching block rule", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "blk", condition: pathCond("/bad"), block: true },
    ]));
    await svc.init();
    expect((await svc.evaluate(makeCtx("/bad"))).block).toBe(true);
    expect((await svc.evaluate(makeCtx("/good"))).block).toBe(false);
  });

  it("block rule disables cache and browser_challenge", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "blk", condition: trueCond, block: true },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/any"));
    expect(dec.cache?.enabled).toBe(false);
    expect(dec.browser_challenge?.enabled).toBe(false);
  });

  it("return rule carries return payload and disables cache", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "ret", condition: pathCond("/custom"), return: { status: 403, text: "Forbidden" } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/custom"));
    expect(dec.block).toBe(false);
    expect(dec.return?.status).toBe(403);
    expect(dec.return?.text).toBe("Forbidden");
    expect(dec.cache?.enabled).toBe(false);
  });

  it("block rule stops further rule processing", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "blk", condition: trueCond, block: true },
      { id: "cache", condition: trueCond, cache: { enabled: true, ttl: 999 } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/any"));
    expect(dec.block).toBe(true);
    expect(dec.cache?.ttl).not.toBe(999);
  });
});

// ─── evaluate：exec ───────────────────────────────────────────────────────────

describe("RuleEngineService - evaluate exec", () => {
  it("exec function can modify state", async () => {
    const svc = new RuleEngineService(makeConfig([
      {
        id: "exec",
        condition: pathCond("/exec"),
        exec: ({ state }: RuleInput) => { (state as any).test = 123; },
      },
    ]));
    await svc.init();
    const ctx = makeCtx("/exec");
    await svc.evaluate(ctx);
    expect(ctx.state.ruleEngineState?.test).toBe(123);
  });
});

// ─── evaluate：cache / browser_challenge 策略合并 ─────────────────────────────

describe("RuleEngineService - evaluate cache / browser_challenge policy", () => {
  it("cache policy from matching rule overrides default", async () => {
    const svc = new RuleEngineService(makeConfig([
      {
        id: "c1",
        condition: ({ ctx }: RuleInput) => ctx.request.path.startsWith("/static/"),
        cache: { enabled: true, ttl: 3600, cache_key_mode: "path" },
      },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/static/logo.png"));
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache?.ttl).toBe(3600);
    expect(dec.cache?.cache_key_mode).toBe("path");
  });

  it("browser_challenge disabled by matching rule", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "bc1", condition: pathCond("/healthz"), browser_challenge: { enabled: false } },
    ]));
    await svc.init();
    expect((await svc.evaluate(makeCtx("/healthz"))).browser_challenge?.enabled).toBe(false);
    expect((await svc.evaluate(makeCtx("/other"))).browser_challenge?.enabled).toBe(true);
  });

  it("later matching rule overrides earlier cache policy (last-hit wins)", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "r1", condition: trueCond, cache: { enabled: true, ttl: 60 } },
      { id: "r2", condition: pathCond("/nocache"), cache: { enabled: false, ttl: 1 } },
    ]));
    await svc.init();
    expect((await svc.evaluate(makeCtx("/nocache"))).cache?.enabled).toBe(false);
    expect((await svc.evaluate(makeCtx("/other"))).cache?.enabled).toBe(true);
  });

  it("last=true stops further rule processing", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "r1", condition: trueCond, cache: { enabled: true, ttl: 100 }, last: true },
      { id: "r2", condition: trueCond, cache: { enabled: false, ttl: 1 } },
    ]));
    await svc.init();
    const dec = await svc.evaluate(makeCtx("/x"));
    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache?.ttl).toBe(100);
  });
});

// ─── evaluate：运行时错误容忍 ─────────────────────────────────────────────────

describe("RuleEngineService - evaluate runtime fault tolerance", () => {
  it("silently skips a rule whose condition throws at runtime", async () => {
    const throwingCond = ({ ctx }: RuleInput) => {
      if (ctx.request.path === "/boom") throw new Error("boom");
      return ctx.request.path === "/safe";
    };
    const svc = new RuleEngineService(makeConfig([
      { id: "r1", condition: throwingCond, cache: { enabled: true, ttl: 42 } },
    ]));
    await svc.init();
    // /boom throws → rule skipped
    expect((await svc.evaluate(makeCtx("/boom"))).cache?.enabled).toBe(false);
    // /safe returns true
    expect((await svc.evaluate(makeCtx("/safe"))).cache?.ttl).toBe(42);
  });
});

// ─── evaluate：cache_key 构建 ─────────────────────────────────────────────────

describe("RuleEngineService - cache_key generation", () => {
  it("default cache_key_mode=path+query sorts query params", async () => {
    const svc = new RuleEngineService(makeConfig([], { cacheEnabled: true }));
    await svc.init();
    const a = await svc.evaluate(makeCtx("/page?a=1&b=2"));
    const b = await svc.evaluate(makeCtx("/page?b=2&a=1"));
    expect(a.cache_key).toBe(b.cache_key);
  });

  it("path mode ignores query string", async () => {
    const svc = new RuleEngineService(makeConfig([
      { id: "c", condition: trueCond, cache: { enabled: true, cache_key_mode: "path" } },
    ]));
    await svc.init();
    const a = await svc.evaluate(makeCtx("/page?x=1"));
    const b = await svc.evaluate(makeCtx("/page?x=2"));
    expect(a.cache_key).toBe(b.cache_key);
  });
});

// ─── evaluate：trace ─────────────────────────────────────────────────────────

describe("RuleEngineService - trace", () => {
  it("emits trace events for rule matching, actions, cache tags, and final decision", async () => {
    const svc = new RuleEngineService(makeConfig([
      {
        id: "miss",
        condition: falseCond,
      },
      {
        id: "hit",
        description: "trace hit",
        condition: trueCond,
        exec: noop,
        cache: {
          enabled: true,
          ttl: 120,
          cache_tags_callback: ({ cacheTags }) => [...cacheTags, "tag:hit"],
        },
        last: true,
      },
    ]));
    await svc.init();

    const events: RuleTraceEvent[] = [];
    const dec = await svc.evaluate(makeCtx("/trace"), {
      trace: (event) => events.push(event),
    });

    expect(dec.cache?.enabled).toBe(true);
    expect(dec.cache_tags).toEqual(["tag:hit"]);
    expect(events.map((event) => event.type)).toContain("site");
    expect(events).toContainEqual({ type: "rule_condition_result", ruleId: "miss", matched: false });
    expect(events).toContainEqual({ type: "rule_condition_result", ruleId: "hit", matched: true });
    expect(events).toContainEqual({ type: "rule_exec_start", ruleId: "hit" });
    expect(events).toContainEqual({ type: "rule_exec_done", ruleId: "hit" });
    expect(events).toContainEqual({ type: "rule_stop", ruleId: "hit", reason: "last" });
    expect(events).toContainEqual({ type: "cache_tags_callback_result", source: "rule", ruleId: "hit", tags: ["tag:hit"] });
    expect(events.at(-1)?.type).toBe("final_decision");
  });

  it("traces condition and exec errors without changing existing fault tolerance", async () => {
    const svc = new RuleEngineService(makeConfig([
      {
        id: "bad-condition",
        condition: () => {
          throw new Error("condition boom");
        },
      },
      {
        id: "bad-exec",
        condition: trueCond,
        exec: () => {
          throw new Error("exec boom");
        },
        cache: { enabled: true, ttl: 99 },
      },
    ]));
    await svc.init();

    const events: RuleTraceEvent[] = [];
    const originalLog = console.log;
    console.log = () => {};
    const dec = await (async () => {
      try {
        return await svc.evaluate(makeCtx("/trace-errors"), {
          trace: (event) => events.push(event),
        });
      } finally {
        console.log = originalLog;
      }
    })();

    expect(dec.cache?.ttl).toBe(99);
    expect(events.some((event) => event.type === "rule_condition_error" && event.ruleId === "bad-condition")).toBe(true);
    expect(events.some((event) => event.type === "rule_exec_error" && event.ruleId === "bad-exec")).toBe(true);
  });
});

