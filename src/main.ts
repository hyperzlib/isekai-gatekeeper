import { loadConfig } from "./config/loadConfig.ts";
import geoip from 'geoip-lite';
import { RuleEngineService } from "./services/ruleEngineService.ts";
import { CacheService } from "./services/cacheService.ts";
import { ProxyService } from "./services/proxyService.ts";
import { createProxyApp, createApiApp } from "./app.ts";
import { TemplateService } from "./services/templateService.ts";
import { GeoIPService } from "./services/geoipService.ts";
import { CaptchaService } from "./services/captchaService.ts";
import { ServiceContainer } from "./types/service.ts";

async function main() {
  const cfg = loadConfig();

  console.log("[boot] Config loaded.");

  const cacheService = new CacheService(cfg);
  const proxyService = new ProxyService(cfg, cacheService);
  const captchaService = new CaptchaService(cfg);

  const templateService = new TemplateService(cfg);
  await templateService.init();

  const geoipService = new GeoIPService(cfg);
  await geoipService.init();

  const serviceContainer: ServiceContainer = {
    cacheService,
    captchaService,
    proxyService,
    tpl: templateService,
    geoipService,
  };

  // 代理服务器
  const proxyApp = createProxyApp(cfg, serviceContainer);
  const proxyServer = proxyApp.listen(cfg.proxy.server_port, () => {
    console.log(`[proxy] Listening on port ${cfg.proxy.server_port}`);
  });

  // API 服务器
  const apiApp = createApiApp(cfg, serviceContainer);
  const apiServer = apiApp.listen(cfg.api.server_port, () => {
    console.log(`[api] Listening on port ${cfg.api.server_port}`);
  });

  // 退出时清理资源
  const shutdown = () => {
    console.log("[boot] Shutting down...");
    proxyServer.close();
    apiServer.close();
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
