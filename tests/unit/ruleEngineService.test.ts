import { describe, it, expect } from "bun:test";
import Koa, { Context } from "koa";
import { RuleEngineService } from "../../src/services/ruleEngineService.ts";
import type { AppConfig, SiteConfig } from "../../src/types/config.ts";
import type { RequestContext } from "../../src/types/decision.ts";
import { IncomingMessage } from "http";
import { OutgoingMessage } from "http";
import { ServerResponse } from "http";

function makeKoaApp(): Koa {
  return new Koa();
}

function makeConfig(rules: AppConfig["sites"][string]["rules"]): AppConfig {
  return {
    proxy: { server_port: 8080 },
    api: { server_port: 8081, key: "key" },
    templatesDir: "./views",
    browser_challenge: {
      enabled: true,
      cookie_ttl: 86400,
      challenge_ttl: 300,
      secret: "secret",
      pow: { difficulty: 16 },
    },
    cache: {
      enabled: false,
      ttl: 60,
      max_entries: 100,
      max_body_bytes: 1_000_000,
      cacheKeyMode: "path+query",
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
  const exampleCtx = app.createContext(httpRequest, httpResponse)
  return exampleCtx;
}

describe("RuleEngineService - compilation", () => {
  it("compiles valid rules without error", () => {
    expect(
      () => new RuleEngineService(makeKoaApp(), makeConfig([
        { id: "r1", condition: "ctx.URL.pathname === '/foo'", actions: { allow: true } },
      ])),
    ).not.toThrow();
  });

  it("throws on forbidden identifier in condition", () => {
    expect(
      () => new RuleEngineService(makeKoaApp(), makeConfig([
        { id: "r1", condition: "eval('1+1') === 2" },
      ])),
    ).toThrow(/rule=r1/);
  });

  it("throws on syntax error in condition", () => {
    expect(
      () => new RuleEngineService(makeKoaApp(), makeConfig([
        { id: "bad", condition: "((( invalid" },
      ])),
    ).toThrow(/rule=bad/);
  });
});

describe("RuleEngineService - evaluate multi-match", () => {
  it("returns allow=false by default (no rules)", () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([]));
    const dec = svc.evaluate(makeCtx(app, "/anything"));
    expect(dec.allow).toBe(false);
  });

  it("allow=true for matching allow rule", () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "r1", condition: "ctx.URL.pathname === '/robots.txt'", actions: { allow: true } },
    ]));
    expect(svc.evaluate(makeCtx(app, "/robots.txt")).allow).toBe(true);
    expect(svc.evaluate(makeCtx(app, "/other")).allow).toBe(false);
  });

  it("later rule overrides allow from earlier rule (last-hit wins)", () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      { id: "r1", condition: "true", actions: { allow: true } },
      { id: "r2", condition: "ctx.URL.pathname === '/block'", actions: { allow: false } },
    ]));
    expect(svc.evaluate(makeCtx(app, "/anything")).allow).toBe(true);
    expect(svc.evaluate(makeCtx(app, "/block")).allow).toBe(false); // r2 overrides r1
  });

  it("last=true stops further rule processing", () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([

      { id: "r1", condition: "true", actions: { allow: true }, last: true },
      { id: "r2", condition: "true", actions: { allow: false } }, // should not run
    ]));
    expect(svc.evaluate(makeCtx(app, "/x")).allow).toBe(true);
  });

  it("cache policy is merged correctly", () => {
    const app = makeKoaApp();
    const svc = new RuleEngineService(app, makeConfig([
      {
        id: "c1",
        condition: "ctx.URL.pathname.startsWith('/wiki/')",
        actions: { cache: { enabled: true, ttl: 300, cacheKeyMode: "path" }, browser_challenge: { enabled: false } },
      },
    ]));
    const dec = svc.evaluate(makeCtx(app, "/wiki/Test"));
    expect(dec.cachePolicy.enabled).toBe(true);
    expect(dec.cachePolicy.ttl).toBe(300);
    expect(dec.cachePolicy.cacheKeyMode).toBe("path");
    expect(dec.browserChallengePolicy.enabled).toBe(false);
  });
});
