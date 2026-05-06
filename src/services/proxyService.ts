import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { Readable } from "node:stream";
import type Koa from "koa";
import type { AppConfig, SiteConfig } from "../types/config.ts";
import type { CacheService } from "./cacheService.ts";
import type { Decision } from "../types/decision.ts";

/**
 * 将 Node.js Readable stream 转为 Web ReadableStream，
 * 用于透传文件上传等流式请求体到 fetch。
 */
function nodeStreamToReadableStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  if (nodeStream.readableFlowing) {
    // 已被消费为 flowing 模式，用 Readable.toWeb 直接转换
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk);
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

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
  private readonly cacheService: CacheService;
  private readonly appConfig: AppConfig;

  constructor(appConfig: AppConfig, cacheService: CacheService) {
    this.appConfig = appConfig;
    this.cacheService = cacheService;
  }

  /**
   * 按 Host 头匹配 site。
   */
  selectSite(ctx: Koa.Context): { id: string; config: SiteConfig } | null {
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
   * 转发请求到后端，可选缓存响应。使用 fetch + pipe。
   */
  async forward(ctx: Koa.Context, site: SiteConfig, decision: Decision): Promise<void> {
    const shouldCache = decision.cache?.enabled && ctx.method === "GET";

    // 如果应该缓存，先尝试从缓存中获取
    if (shouldCache) {
      const cached = await this.cacheService.get<PageCacheEntry>(decision.cache_key);
      if (cached) {
        const now = Date.now();
        const age = now - cached.cachedAt;
        if (age < cached.ttl * 1000) {
          ctx.status = cached.status;
          for (const [k, v] of Object.entries(cached.headers)) {
            ctx.set(k, v);
          }
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

    // 构建后端请求 URL
    const targetUrl = site.backend.url.replace(/\/$/, "") + ctx.url;

    // 收集需要转发到后端的请求头（排除 hop-by-hop 头）
    const forwardHeaders: Record<string, string> = {
      "x-forwarded-for": ctx.ip,
      "x-forwarded-proto": ctx.protocol,
      "x-forwarded-host": ctx.headers["host"] ?? "",
      "forwarded": `by=isekai-gatekeeper; for=${ctx.ip}; proto=${ctx.protocol}; host=${ctx.headers["host"] ?? ""}`,
    };

    // 透传客户端的非 hop-by-hop 头
    const hopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade",
    ]);
    for (const [k, v] of Object.entries(ctx.headers)) {
      if (!hopByHop.has(k.toLowerCase()) && !forwardHeaders[k.toLowerCase()]) {
        forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v ?? "";
      }
    }

    if (site.backend.hostname) {
      forwardHeaders["host"] = site.backend.hostname;
    }
    if (site.backend.headers) {
      Object.assign(forwardHeaders, renderHeaders(site.backend.headers, ctx));
    }

    // 请求体转发：multipart（文件上传）→ 流式转发；JSON/form → 字符串化
    const contentType = (ctx.request.type ?? ctx.headers["content-type"] ?? "").toLowerCase();
    const isMultipart = contentType.startsWith("multipart/form-data");
    const isStreamableBody = ctx.method !== "GET" && ctx.method !== "HEAD";

    let body: string | ReadableStream<Uint8Array> | undefined;
    if (isStreamableBody) {
      if (isMultipart) {
        // 文件上传：直接透传原始流
        forwardHeaders["content-type"] = contentType;
        body = nodeStreamToReadableStream(ctx.req);
      } else if (ctx.request.body && ctx.request.rawBody) {
        // 文本类型的 body（如 JSON、表单）
        body = ctx.request.rawBody;
        forwardHeaders["content-type"] = ctx.request.type || "application/json";
      } else {
        // 未知的流式 body（如 application/octet-stream）
        forwardHeaders["content-type"] = contentType || "application/octet-stream";
        body = nodeStreamToReadableStream(ctx.req);
      }
    }

    let resp: Response;
    try {
      resp = await fetch(targetUrl, {
        method: ctx.method,
        headers: forwardHeaders,
        body,
        redirect: "manual",
      });
    } catch (err) {
      console.error("[ProxyService] fetch error:", err);
      ctx.status = 502;
      ctx.body = "Bad Gateway";
      return;
    }

    // 复制状态码和响应头到 client
    ctx.status = resp.status;
    const responseHeaders: Record<string, string> = {};
    const responseHopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length",
    ]);
    resp.headers.forEach((value, key) => {
      if (!responseHopByHop.has(key.toLowerCase())) {
        responseHeaders[key] = value;
        ctx.set(key, value);
      }
    });

    // 缓存逻辑
    if (shouldCache && resp.body) {
      let contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes(";")) {
        contentType = contentType.split(";")[0]?.trim() ?? "";
      }

      const allowedStatuses = [200, 301, 308];
      if (allowedStatuses.includes(resp.status) && this.appConfig.cache.allowed_mimetypes.includes(contentType)) {
        try {
          const chunks: Buffer[] = [];
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
          }
          const rawBody: Buffer = Buffer.concat(chunks);

          // 解压缩
          const contentEncoding = (responseHeaders["content-encoding"] ?? "").toLowerCase().trim();
          let bodyBuffer = rawBody;
          const cachedHeaders = { ...responseHeaders };
          if (contentEncoding) {
            try {
              bodyBuffer = decodeContentEncoding(rawBody, contentEncoding);
              delete cachedHeaders["content-encoding"];
              cachedHeaders["content-length"] = String(bodyBuffer.length);
            } catch {
              // 解压失败，保留原始数据
            }
          }

          const bodyText = bodyBuffer.toString("utf-8");
          this.cacheService.set<PageCacheEntry>(decision.cache_key, {
            status: resp.status,
            headers: cachedHeaders,
            body: bodyText,
            cachedAt: Date.now(),
            ttl: decision.cache?.ttl ?? this.appConfig.cache.default_ttl,
          }, decision.cache?.ttl ?? this.appConfig.cache.default_ttl);

          if (this.appConfig.debug) {
            console.log(`[ProxyService] Cached: ${resp.status} ${ctx.url} (key: ${decision.cache_key})`);
          }

          ctx.body = bodyText;
          return;
        } catch (err) {
          console.error("[ProxyService] Failed to cache response:", err);
        }
      }
    }

    // 非缓存路径：直接将 fetch 的 body stream pipe 到 Koa response
    if (resp.body) {
      ctx.set("X-Cache", "MISS");
      // 将 Web ReadableStream 转为 Node.js Readable 并设置到 body
      ctx.body = Readable.from(
        (async function* () {
          const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })(),
      );
    }

    if (this.appConfig.debug) {
      console.log(`[ProxyService] Forwarded: ${ctx.method} ${ctx.url} → ${resp.status}`);
    }
  }

  close(): void {
    // No-op: fetch 无需关闭
  }
}
