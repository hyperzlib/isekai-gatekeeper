import { loadConfig } from "./config/loadConfig.ts";
import { CacheService } from "./services/cacheService.ts";
import { CleanupService } from "./services/cleanupService.ts";
import { ProxyService } from "./services/proxyService.ts";
import { createProxyApp, createApiApp } from "./app.ts";
import { TemplateService } from "./services/templateService.ts";
import { GeoIPService } from "./services/geoipService.ts";
import { CaptchaService } from "./services/captchaService.ts";
import { ServiceContainer } from "./types/service.ts";
import { RateLimitService } from "./services/rateLimitService.ts";
import { SiteResolver } from "./services/siteResolver.ts";

async function main() {
  const cfg = await loadConfig();

  console.log("[boot] Config loaded.");

  const cacheService = new CacheService(cfg);
  await cacheService.init();

  const siteResolver = new SiteResolver(cfg);
  const proxyService = new ProxyService(cfg, cacheService, siteResolver);
  const captchaService = new CaptchaService(cfg);

  const rateLimitService = new RateLimitService(cacheService);

  const templateService = new TemplateService(cfg);
  await templateService.init();

  const geoipService = new GeoIPService(cfg);
  await geoipService.init();

  // 集中清理服务
  const cleanupService = new CleanupService();
  cleanupService.register(
    "cache-tag-expiry",
    5 * 60 * 1000, // 每 5 分钟
    () => cacheService.cleanExpiredTagIndices(),
  );
  cleanupService.start();

  const serviceContainer: ServiceContainer = {
    cacheService,
    captchaService,
    cleanupService,
    rateLimitService,
    proxyService,
    siteResolver,
    tpl: templateService,
    geoipService,
  };

  // 代理服务器
  const proxyApp = await createProxyApp(cfg, serviceContainer);
  const proxyServer = Bun.serve({
    port: cfg.proxy.server_port,
    fetch: proxyApp.fetch,
  });
  console.log(`[proxy] Listening on port ${cfg.proxy.server_port}`);

  // API 服务器
  const apiApp = await createApiApp(cfg, serviceContainer);
  const apiServer = Bun.serve({
    port: cfg.api.server_port,
    fetch: apiApp.fetch,
  });
  console.log(`[api] Listening on port ${cfg.api.server_port}`);

  // 退出时清理资源
  const shutdown = () => {
    console.log("[boot] Shutting down...");
    cleanupService.stop();
    proxyServer.stop();
    apiServer.stop();
    proxyService.close();
    templateService.close();
    geoipService.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[boot] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
