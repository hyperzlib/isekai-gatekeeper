import type { AppConfig } from "./src/types/config.ts";

const config: AppConfig = {
  debug: false,
  templates_dir: "./views",

  proxy: {
    server_port: 8080,
  },

  api: {
    server_port: 8081,
    key: "change-me-api-key",
  },

  browser_challenge: {
    enabled: true,
    cookie_ttl: 86400,           // 秒，PoW Cookie 有效期
    challenge_ttl: 300,          // 秒，挑战有效期
    secret: "change-me-pow-secret",
    pow: { difficulty: 16 },     // 前导零 bit 数
  },

  cache: {
    enabled: true,
    provider: "memory",          // 可选 "memory" | "bun+redis" | "redis"
    default_ttl: 60,            // 秒
    cache_key_mode: "path+query", // "path+query" | "path"
    max_entries: 1000,
    max_body_bytes: 1048576,    // 1 MiB
    allowed_mimetypes: [
      "text/html", "application/json", "text/plain",
      "text/css", "application/javascript", "text/javascript",
    ],
    bypass_after_challenge: true,
    // bun_redis: { url: "redis://localhost:6379" },
    // redis: { url: "redis://localhost:6379" },
  },

  // ── GeoIP (可选) ──────────────────────────────────────────────────────
  // 需要从 https://dev.maxmind.com/geoip/geolite2-free-geolocation-data 下载数据库
  // geoip: {
  //   enabled: true,
  //   db_country_path: "./data/geoip/GeoLite2-Country.mmdb",
  //   db_asn_path: "./data/geoip/GeoLite2-ASN.mmdb",
  //   db_city_path: "./data/geoip/GeoLite2-City.mmdb",
  // },

  // ── 验证码 (可选) ────────────────────────────────────────────────────
  // captcha: {
  //   enabled: true,
  //   type: "recaptcha",
  //   recaptcha: { site_key: "", secret_key: "" },
  //   hcaptcha: { site_key: "", secret_key: "" },
  //   geetest: { id: "", key: "" },
  //   turnstile: { site_key: "", secret_key: "" },
  //   funcaptcha: { public_key: "", private_key: "" },
  //   aliyun: { access_key_id: "", access_key_secret: "" },
  //   tencent: { secret_id: "", secret_key: "" },
  // },

  // ── 站点配置 ──────────────────────────────────────────────────────────

  sites: {
    example: {
      hostname: "example.com",
      backend: {
        url: "http://127.0.0.1:80",
        hostname: "example.com",
        headers: {
          "X-Proxy-Server": "isekai-gatekeeper",
          // 兼容 Cloudflare Headers — 使用函数动态计算
          "CF-IPCountry": ({ ctx }) => ctx.get("geoip")?.countryCode ?? "XX",
          "CF-Visitor": ({ presets }) => presets.isHttps ? 'https': 'http',
        },
      },
      rules: [
        // 规则：放行 robots.txt / sitemap.xml
        {
          id: "allow-static",
          description: "allow robots and sitemap",
          condition: ({ http }) =>
            ["/robots.txt", "/sitemap.xml"].includes(http.request.uri.path),
          browser_challenge: { enabled: false },
        },

        // 规则：放行常见搜索引擎爬虫 UA
        {
          id: "allow-bot-user-agent",
          description: "allow bot user agent",
          condition: ({ presets }) => presets.isCommonSearchEngineBot,
          browser_challenge: { enabled: false },
        },

        // 规则：放行 wiki 页面 (返回缓存)
        {
          id: "cache-wiki",
          condition: ({ http, utils }) =>
            utils.matchGlob(http.request.uri.path, "/wiki/*"),
          last: true,
          cache: {
            enabled: true,
            ttl: 86400,
            cache_key_mode: "path+query",
            cache_tags_callback: ({ http, cacheTags }) => {
              const tags = [...cacheTags, "wiki"];
              const match = http.request.uri.path.match(/^\/wiki\/(?<title>.+?)\/?$/);
              const title = match?.groups?.title;
              if (title) tags.push(title);
              return tags;
            },
          },
          browser_challenge: { enabled: false },
        },

        // 规则：放行来自 CN 的请求
        {
          id: "allow-cn",
          description: "allow traffic from China",
          condition: ({ ctx }) => ctx.get("geoip")?.countryCode === "CN",
          browser_challenge: { enabled: false },
        },
      ],
    },
  },
};

export default config;
