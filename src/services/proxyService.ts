import http from "node:http";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import httpProxy from "http-proxy";
import type Koa from "koa";
import type { AppConfig, SiteConfig } from "../types/config.ts";
import type { CacheService } from "./cacheService.ts";
import type { Decision } from "../types/decision.ts";

type PendingCacheEntry = {
  res: http.ServerResponse;
  cacheKey: string;
  ttl: number;
  settleResolve: () => void;
  settleReject: (err: unknown) => void;
};

type PageCacheEntry = {
  status: number;
  headers: Record<string, string>;
  body: string;
  cachedAt: number;
  ttl: number;
};

/**
 * 渲染后端请求头模板（支持 Handlebars 语法）。
 */
function renderHeaders(
  headerTemplates: Record<string, HandlebarsTemplateDelegate>,
  ctx: Koa.Context,
): Record<string, string> {
  const tplCtx = {
    http: {
      request: {
        headers: Object.fromEntries(
          Object.entries(ctx.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
        ),
      },
    },
  };
  const result: Record<string, string> = {};
  for (const [key, render] of Object.entries(headerTemplates)) {
    result[key] = render(tplCtx);
  }
  return result;
}

function decodeContentEncoding(body: Buffer, encoding: string): Buffer {
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

export class ProxyService {
  private readonly proxy: httpProxy;
  private readonly cacheService: CacheService;
  private readonly appConfig: AppConfig;
  private readonly pendingCache = new WeakMap<http.IncomingMessage, PendingCacheEntry>();

  constructor(appConfig: AppConfig, cacheService: CacheService) {
    this.appConfig = appConfig;
    this.cacheService = cacheService;
    this.proxy = httpProxy.createProxyServer({ changeOrigin: false });
    this.proxy.on("proxyRes", this.onProxyRes);

    this.proxy.on("error", (err, _req, res) => {
      console.error("[ProxyService] Proxy error:", err);
      if (res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });
  }

  private readonly onProxyRes = (
    proxyRes: http.IncomingMessage,
    incomingReq: http.IncomingMessage,
    incomingRes: http.ServerResponse,
  ): void => {
    const pending = this.pendingCache.get(incomingReq);
    if (!pending) {
      return;
    }
    if (pending.res !== incomingRes) {
      return;
    }

    const status = proxyRes.statusCode ?? 0;
    let contentType = proxyRes.headers["content-type"] ?? "";
    if (contentType.includes(";")) {
      contentType = contentType.split(";")[0]?.trim() ?? "";
    }

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v !== undefined) {
        responseHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on("end", () => {
      if (this.appConfig.debug) {
        console.log(`[ProxyService] Received response: ${status} ${incomingReq.url} (Content-Type: ${contentType}, Cache-Key: ${pending.cacheKey})`);
      }

      this.pendingCache.delete(incomingReq);
      let rawBody: Buffer<ArrayBufferLike> = Buffer.concat(chunks);

      if (rawBody.length === 0) {
        // 空响应体需要发送一个空行以正确结束 HTTP 响应，否则 Nginx 会返回 502 错误
        incomingRes.write("\r\n");
        return;
      }

      if (status === 200 && this.appConfig.cache.allowed_mimetypes.includes(contentType)) {
        try {
          const cachedHeaders = { ...responseHeaders };

          // 解压缩响应体
          const contentEncoding = (responseHeaders["content-encoding"] ?? "").toLowerCase().trim();
          if (contentEncoding) {
            rawBody = decodeContentEncoding(rawBody, contentEncoding);

            // 移除编码相关 header，更新 content-length
            delete cachedHeaders["content-encoding"];
            cachedHeaders["content-length"] = String(rawBody.length);
          }

          const bodyText = rawBody.toString("utf-8");
          this.cacheService.set<PageCacheEntry>(pending.cacheKey, {
            status,
            headers: cachedHeaders,
            body: bodyText,
            cachedAt: Date.now(),
            ttl: pending.ttl,
          }, pending.ttl);
        } catch (err) {
          console.error("[ProxyService] Failed to cache response:", err);
        }
      }

      pending.settleResolve();
    });
    proxyRes.on("error", (err) => {
      this.pendingCache.delete(incomingReq);
      pending.settleReject(err);
    });
  };

  /**
   * 按 Host 头匹配 site。
   */
  selectSite(ctx: Koa.Context): { id: string, config: SiteConfig } | null {
    const host = (ctx.headers["host"] ?? "").split(":")[0] ?? "";
    for (const [siteId, site] of Object.entries(this.appConfig.sites)) {
      if (Array.isArray(site.hostname)) {
        if (site.hostname.includes(host)) {
          return { id: siteId, config: site };
        }
      } else if (site.hostname === host) {
        return { id: siteId, config: site };
      }
    }
    return null;
  }

  /**
   * 转发请求到后端，可选缓存响应。
   */
  async forward(ctx: Koa.Context, site: SiteConfig, decision: Decision): Promise<void> {
    const shouldCache =
      decision.cache?.enabled && ctx.method === "GET";

    // 如果应该缓存，先尝试从缓存中获取
    if (shouldCache) {
      const cached = await this.cacheService.get<PageCacheEntry>(decision.cache_key);

      if (cached) {
        const now = Date.now();
        const age = now - cached.cachedAt;
        if (age < cached.ttl * 1000) {
          // 缓存未过期，直接返回
          ctx.status = cached.status;
          Object.assign(ctx.headers, cached.headers);

          ctx.set("X-Cache", "HIT");
          const cacheAge = Math.floor(age / 1000).toString();
          ctx.set("X-Cache-Age", cacheAge);
          ctx.set("Age", cacheAge);
          ctx.set("Expires", new Date(cached.cachedAt + cached.ttl * 1000).toUTCString());

          ctx.body = cached.body;
          return;
        }
      }
    }

    return new Promise<void>((resolve, reject) => {
      const req = ctx.req;
      const res = ctx.res;
      let settled = false;

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        console.log(`[ProxyService] Finished processing request: ${ctx.method} ${ctx.url} (cache: ${shouldCache ? "enabled" : "disabled"})`);
        resolve();
      };

      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      // 设置附加请求头
      const extraHeaders: Record<string, string> = {
        "X-Real-IP": ctx.ip,
        "X-Forwarded-For": ctx.ip,
        "X-Forwarded-Proto": ctx.protocol,
        "X-Forwarded-Host": ctx.headers["host"] ?? "",
        "Forwarded": `by=isekai-gatekeeper; for=${ctx.ip}; proto=${ctx.protocol}; host=${ctx.headers["host"] ?? ""}`,
      };
      if (site.backend.hostname) {
        extraHeaders["host"] = site.backend.hostname;
      }
      if (site.backend.headers) {
        Object.assign(extraHeaders, renderHeaders(site.backend.headers, ctx));
      }
      for (const [k, v] of Object.entries(extraHeaders)) {
        req.headers[k] = v;
      }

      if (!shouldCache) {
        ctx.respond = false;
        res.once("finish", settleResolve);
        this.proxy.web(req, res, { target: site.backend.url }, (err) => {
          console.error("[ProxyService] Proxy error:", err);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Bad Gateway");
          }
          settleResolve();
        });
        return;
      }

      ctx.set("X-Cache", "MISS");
      ctx.respond = false;
      this.pendingCache.set(req, {
        res,
        cacheKey: decision.cache_key,
        ttl: decision.cache?.ttl ?? this.appConfig.cache.default_ttl,
        settleResolve,
        settleReject,
      });

      this.proxy.web(req, res, { target: site.backend.url }, (err) => {
        console.error("[ProxyService] Proxy error:", err);
        this.pendingCache.delete(req);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Bad Gateway");
        }
        settleResolve();
      });
    });
  }

  close(): void {
    this.proxy.close();
  }
}
