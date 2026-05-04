import http from "node:http";
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
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v !== undefined) {
        responseHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on("end", () => {
      this.pendingCache.delete(incomingReq);
      const body = Buffer.concat(chunks);

      if (status === 200) {
        this.cacheService.set(pending.cacheKey, {
          status,
          headers: responseHeaders,
          body: new Uint8Array(body),
          cachedAt: Date.now(),
          ttl: pending.ttl,
        });
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
  selectSite(ctx: Koa.Context): SiteConfig | null {
    const host = (ctx.headers["host"] ?? "").split(":")[0] ?? "";
    for (const site of Object.values(this.appConfig.sites)) {
      if (site.hostname === host) return site;
    }
    return null;
  }

  /**
   * 转发请求到后端，可选缓存响应。
   */
  forward(ctx: Koa.Context, site: SiteConfig, decision: Decision): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req = ctx.req;
      const res = ctx.res;
      let settled = false;

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      // 设置附加请求头
      const extraHeaders: Record<string, string> = {
        "X-Forwarded-For": ctx.ip,
        "X-Real-IP": ctx.ip,
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

      const shouldCache =
        decision.cachePolicy.enabled && ctx.method === "GET";

      if (!shouldCache) {
        ctx.respond = false;
        res.once("finish", settleResolve);
        this.proxy.web(req, res, { target: site.backend.url }, (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Bad Gateway");
          }
          settleResolve();
        });
        return;
      }

      ctx.respond = false;
      this.pendingCache.set(req, {
        res,
        cacheKey: decision.cacheKey,
        ttl: decision.cachePolicy.ttl,
        settleResolve,
        settleReject,
      });

      this.proxy.web(req, res, { target: site.backend.url }, (err) => {
        this.pendingCache.delete(req);
        console.log("Proxy error:", err);
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
