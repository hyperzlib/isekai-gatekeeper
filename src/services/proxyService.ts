import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import type { AppConfig, SiteConfig } from "../types/config.ts";
import type { CacheService } from "./cacheService.ts";
import type { Decision } from "../types/decision.ts";
import type { CachedResponse } from "../types/cache.ts";
import type { RuleInput, HeaderBuilder } from "../types/rule.ts";
import { RulePresets } from "../utils/RulePresets.ts";
import { RuleRateLimit } from "../utils/RuleRateLimit.ts";
import { ruleExpressionTools } from "../utils/RuleTools.ts";
import { toCloudflareHttp } from "../utils/http.ts";
import { SiteResolver } from "./siteResolver.ts";
import type { AppContext, RuleContext } from "../types/hono.ts";
import { getRequestHost, getRequestIp, getRequestProtocol } from "../utils/request.ts";

/**
 * 渲染后端请求头。string 直接使用，函数接收 RuleInput 上下文后返回值。
 * 函数返回 null/undefined 则跳过该 header。
 */
function renderHeaders(
  headerTemplates: Record<string, string | HeaderBuilder>,
  expressionGlobal: RuleInput,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerTemplates)) {
    if (typeof value === "function") {
      const resolved = value(expressionGlobal);
      if (resolved != null) {
        result[key] = resolved;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function decodeContentEncoding(body: Buffer<ArrayBufferLike>, encoding: string): Buffer<ArrayBufferLike> {
  encoding = encoding.toLowerCase().trim();
  if (encoding === "gzip") {
    return gunzipSync(body);
  } else if (encoding === "br") {
    return brotliDecompressSync(body);
  } else if (encoding === "deflate") {
    return inflateSync(body);
  } else {
    return body;
  }
}

function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "image/svg+xml"
  );
}

function appendHeader(headers: Headers, key: string, rawValue: string | string[]): void {
  if (Array.isArray(rawValue)) {
    for (const value of rawValue) headers.append(key, value);
  } else {
    headers.set(key, rawValue);
  }
}

function sendCachedResponse(cached: CachedResponse, age: number): Response {
  const cacheAge = Math.floor(age / 1000).toString();
  const headers = new Headers();
  for (const [key, value] of Object.entries(cached.headers)) {
    appendHeader(headers, key, value);
  }
  headers.set("x-cache", "HIT");
  headers.set("x-cache-age", cacheAge);
  headers.set("age", cacheAge);
  headers.set("expires", new Date(cached.cachedAt + cached.ttl * 1000).toUTCString());

  return new Response(cached.body, {
    status: cached.status,
    headers,
  });
}

export class ProxyService {
  private readonly cacheService: CacheService;
  private readonly appConfig: AppConfig;

  constructor(
    appConfig: AppConfig,
    cacheService: CacheService,
    private readonly siteResolver = new SiteResolver(appConfig),
  ) {
    this.appConfig = appConfig;
    this.cacheService = cacheService;
  }

  /**
   * 按 Host 头匹配 site。
   */
  selectSite(ctx: AppContext): { id: string; config: SiteConfig } | null {
    const site = this.siteResolver.resolve(ctx);
    return site ? { id: site.id, config: site.config } : null;
  }

  /**
   * 转发请求到后端，可选缓存响应。使用 Fetch API 直接返回 Hono Response。
   */
  async forward(ctx: AppContext, site: SiteConfig, decision: Decision): Promise<Response> {
    const method = ctx.req.raw.method.toUpperCase();
    const shouldCache = decision.cache?.enabled && method === "GET";

    if (shouldCache) {
      const cached = await this.cacheService.getCachedResponse(decision.cache_key);
      if (cached) {
        const now = Date.now();
        const age = now - cached.cachedAt;
        if (age < cached.ttl * 1000) {
          return sendCachedResponse(cached, age);
        }
      }
    }

    const requestUrl = new URL(ctx.req.url);
    const targetUrl = site.backend.url.replace(/\/$/, "") + requestUrl.pathname + requestUrl.search;
    const ip = getRequestIp(ctx);
    const protocol = getRequestProtocol(ctx);
    const originalHost = getRequestHost(ctx);

    const forwardHeaders = new Headers({
      "x-forwarded-for": ip,
      "x-forwarded-proto": protocol,
      "x-forwarded-host": originalHost,
      "forwarded": `by=isekai-gatekeeper; for=${ip}; proto=${protocol}; host=${originalHost}`,
    });

    const hopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade",
    ]);
    for (const [key, value] of ctx.req.raw.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (!hopByHop.has(lowerKey) && !forwardHeaders.has(lowerKey)) {
        forwardHeaders.set(key, value);
      }
    }

    if (site.backend.hostname) {
      forwardHeaders.set("host", site.backend.hostname);
    }
    if (site.backend.headers) {
      let state = ctx.get("ruleEngineState");
      if (!state) {
        state = {};
        ctx.set("ruleEngineState", state);
      }
      const exprGlobal = {
        ctx: ctx as RuleContext,
        http: toCloudflareHttp(ctx),
        presets: new RulePresets(ctx),
        rateLimit: new RuleRateLimit(ctx),
        state,
        ...ruleExpressionTools,
      };
      const renderedHeaders = renderHeaders(site.backend.headers, exprGlobal as RuleInput);
      for (const [key, value] of Object.entries(renderedHeaders)) {
        forwardHeaders.set(key, value);
      }
    }

    const body = method !== "GET" && method !== "HEAD" ? ctx.req.raw.body : undefined;

    let resp: Response;
    try {
      resp = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        redirect: "manual",
      });
    } catch (err) {
      console.error("[ProxyService] fetch error:", err);
      return new Response("Bad Gateway", { status: 502 });
    }

    const responseHeaders = new Headers();
    const cachedResponseHeaders: Record<string, string[]> = {};
    const responseHopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length",
    ]);
    resp.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!responseHopByHop.has(lowerKey)) {
        responseHeaders.append(lowerKey, value);
        cachedResponseHeaders[lowerKey] ??= [];
        cachedResponseHeaders[lowerKey]!.push(value);
      }
    });

    if (shouldCache && resp.body) {
      let contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes(";")) {
        contentType = contentType.split(";")[0]?.trim() ?? "";
      }

      responseHeaders.set("x-cache", "MISS");

      const allowedStatuses = [200, 301, 308];
      const cacheableTextResponse =
        allowedStatuses.includes(resp.status) &&
        this.appConfig.cache.allowed_mimetypes.includes(contentType) &&
        isTextContentType(contentType);
      if (cacheableTextResponse) {
        responseHeaders.set("x-cache-reason", "MISS_CACHEABLE");
        try {
          const rawBody: Buffer<ArrayBufferLike> = Buffer.from(await resp.arrayBuffer());

          const contentEncoding = (resp.headers.get("content-encoding") ?? "").toLowerCase().trim();
          let bodyBuffer = rawBody;
          const cachedHeaders = { ...cachedResponseHeaders };
          if (contentEncoding) {
            try {
              bodyBuffer = decodeContentEncoding(rawBody, contentEncoding);
              delete cachedHeaders["content-encoding"];
              cachedHeaders["content-length"] = [String(bodyBuffer.length)];
            } catch {
              // 解压失败时保留原始数据。
            }
          }

          const bodyText = bodyBuffer.toString("utf-8");
          const cacheTags = decision.cache_tags;
          await this.cacheService.setCachedResponse(decision.cache_key, {
            status: resp.status,
            headers: cachedHeaders,
            body: bodyText,
            cachedAt: Date.now(),
            ttl: decision.cache?.ttl ?? this.appConfig.cache.default_ttl,
            tags: cacheTags,
          }, decision.cache?.ttl ?? this.appConfig.cache.default_ttl, cacheTags);

          if (this.appConfig.debug) {
            console.log(`[ProxyService] Cached: ${resp.status} ${requestUrl.pathname}${requestUrl.search} (key: ${decision.cache_key})`);
          }

          return new Response(bodyText, {
            status: resp.status,
            headers: responseHeaders,
          });
        } catch (err) {
          console.error("[ProxyService] Failed to cache response:", err);
        }
      } else {
        responseHeaders.set("x-cache-reason", isTextContentType(contentType) ? "UNCACHEABLE" : "UNCACHEABLE_NON_TEXT");
      }
    }

    if (this.appConfig.debug) {
      console.log(`[ProxyService] Forwarded: ${method} ${requestUrl.pathname}${requestUrl.search} -> ${resp.status}`);
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: responseHeaders,
    });
  }

  close(): void {
    // No-op: fetch 无需关闭
  }
}
