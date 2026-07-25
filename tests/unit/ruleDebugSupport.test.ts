import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import type { AppConfig, SiteConfig } from "../../src/types/config.ts";
import { CacheService } from "../../src/services/cacheService.ts";
import { ProxyService } from "../../src/services/proxyService.ts";
import { RateLimitService } from "../../src/services/rateLimitService.ts";
import { RuleEngineService } from "../../src/services/ruleEngineService.ts";
import type { DebugRuntime } from "../../cli/ruleDebugSupport.ts";
import {
  createDebugContext,
  evaluateDebugRequest,
  loadDebugHistory,
  saveDebugHistory,
} from "../../cli/ruleDebugSupport.ts";

function makeConfig(): AppConfig {
  return {
    proxy: { server_port: 8080 },
    api: { server_port: 8081, key: "key" },
    templates_dir: "./views",
    browser_challenge: {
      enabled: true,
      cookie_ttl: 86400,
      challenge_ttl: 300,
      secret: "secret",
      pow: { difficulty: 16 },
    },
    cache: {
      enabled: false,
      provider: "memory",
      default_ttl: 60,
      max_entries: 100,
      max_body_bytes: 1_000_000,
      cache_key_mode: "path+query",
      allowed_mimetypes: ["text/html"],
      bypass_after_challenge: true,
    },
    sites: {
      wiki: {
        hostname: ["example.com", "www.example.com"],
        backend: { url: "http://localhost:8000" },
        rules: [
          {
            id: "inspect-context",
            condition: ({ ctx, http }) =>
              ctx.validatedClientId === "client-1" &&
              ctx.geoip?.countryCode === "JP" &&
              http.request.cookies["session"]?.[0] === "abc" &&
              http.request.headers.map["content-length"]?.[0] === "5",
            cache: { enabled: true, ttl: 30 },
            last: true,
          },
        ],
      } as SiteConfig,
    },
  };
}

async function makeRuntime(): Promise<DebugRuntime> {
  const config = makeConfig();
  const cacheService = new CacheService(config);
  await cacheService.init();
  const rateLimitService = new RateLimitService(cacheService);
  const proxyService = new ProxyService(config, cacheService);
  const ruleEngine = new RuleEngineService(config);
  await ruleEngine.init();
  return {
    config,
    cacheMode: "memory",
    cacheService,
    rateLimitService,
    proxyService,
    ruleEngine,
  };
}

describe("ruleDebugSupport - debug context", () => {
  it("builds a Koa context with site, cookies, headers, client state, geoip, and body metadata", async () => {
    const runtime = await makeRuntime();
    const ctx = createDebugContext(runtime, {
      name: "ctx",
      method: "POST",
      url: "/page?a=1",
      host: "example.com",
      headers: { "user-agent": "debug" },
      cookies: { session: "abc" },
      clientIp: "203.0.113.10",
      validatedClientId: "client-1",
      geoip: { countryCode: "JP", asn: 64500 },
      bodyContentType: "application/json",
      bodyLength: 5,
    });

    expect(ctx.currentSiteId).toBe("wiki");
    expect(ctx.currentSite?.hostname).toEqual(["example.com", "www.example.com"]);
    expect(ctx.ip).toBe("203.0.113.10");
    expect(ctx.validatedClientId).toBe("client-1");
    expect(ctx.geoip?.countryCode).toBe("JP");
    expect(ctx.request.headers["cookie"]).toBe("session=abc");
    expect(ctx.request.headers["content-type"]).toBe("application/json");
    expect(ctx.request.headers["content-length"]).toBe("5");
    expect((ctx.request as any).rawBody).toBe(".....");
  });

  it("runs simulated requests through the real rule engine", async () => {
    const runtime = await makeRuntime();
    const result = await evaluateDebugRequest(runtime, {
      name: "run",
      method: "POST",
      url: "/page?a=1",
      host: "example.com",
      headers: {},
      cookies: { session: "abc" },
      clientIp: "203.0.113.10",
      validatedClientId: "client-1",
      geoip: { countryCode: "JP" },
      bodyContentType: "text/plain",
      bodyLength: 5,
    });

    expect(result.siteFound).toBe(true);
    expect(result.decision.cache?.enabled).toBe(true);
    expect(result.decision.cache?.ttl).toBe(30);
    expect(result.trace.some((event) => event.type === "final_decision")).toBe(true);
  });
});

describe("ruleDebugSupport - history files", () => {
  it("falls back to the example file when local history is missing and saves local history", () => {
    const dir = mkdtempSync(join(tmpdir(), "rule-debug-"));
    try {
      const historyPath = join(dir, "rule-debug.json");
      const examplePath = join(dir, "rule-debug.example.json");
      writeFileSync(examplePath, JSON.stringify({
        requests: [
          {
            name: "Example",
            method: "GET",
            url: "/example",
            host: "example.com",
            headers: {},
            cookies: {},
            clientIp: "127.0.0.1",
          },
        ],
      }), "utf-8");

      const history = loadDebugHistory(historyPath, examplePath);
      expect(history.requests[0]?.name).toBe("Example");

      history.requests[0]!.name = "Saved";
      saveDebugHistory(history, historyPath);

      const saved = JSON.parse(readFileSync(historyPath, "utf-8")) as { requests: Array<{ name: string }> };
      expect(saved.requests[0]?.name).toBe("Saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
