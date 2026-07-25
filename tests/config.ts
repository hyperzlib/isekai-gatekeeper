import type { AppConfig } from "../src/types/config.ts";

const config: AppConfig = {
  debug: true,
  templates_dir: "./views",

  proxy: { server_port: 19080 },
  api: { server_port: 19081, key: "test-api-key" },

  browser_challenge: {
    enabled: true,
    cookie_ttl: 86400,
    challenge_ttl: 300,
    secret: "integration-test-secret",
    pow: { difficulty: 8 },
  },

  cache: {
    enabled: true,
    provider: "memory",
    default_ttl: 60,
    cache_key_mode: "path+query",
    max_entries: 1024,
    max_body_bytes: 1048576,
    allowed_mimetypes: ["text/plain", "text/html", "application/json"],
    bypass_after_challenge: true,
  },

  sites: {
    test: {
      hostname: "test.local",
      backend: {
        url: "http://127.0.0.1:19090",
        hostname: "upstream.test.local",
      },
      rules: [
        {
          id: "allow-open",
          condition: ({ ctx }) => ctx.URL.pathname === "/open",
          browser_challenge: { enabled: false },
          cache: { enabled: false },
          last: true,
        },
        {
          id: "cache-page",
          condition: ({ ctx }) => ctx.URL.pathname === "/cache",
          browser_challenge: { enabled: false },
          cache: { enabled: true, ttl: 600, cache_key_mode: "path+query" },
          last: true,
        },
        {
          id: "allow-upload",
          condition: ({ ctx }) => ctx.URL.pathname === "/upload",
          browser_challenge: { enabled: false },
          cache: { enabled: false },
          last: true,
        },
      ],
    },
  },
};

export default config;
