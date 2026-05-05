import Koa from "koa";
import bodyParser from "@koa/bodyparser";
import type { AppConfig } from "./types/config.ts";
import { RuleEngineService } from "./services/ruleEngineService.ts";
import type { CacheService } from "./services/cacheService.ts";
import type { ProxyService } from "./services/proxyService.ts";
import { errorMiddleware } from "./middlewares/errorMiddleware.ts";
import { firewallMiddleware } from "./middlewares/firewallMiddleware.ts";
import { registerProxyRoutes, registerAdminRoutes } from "./routes/index.ts";
import { TemplateService } from "./services/templateService.ts";
import { GeoIPService } from "./services/geoipService.ts";
import { ipMiddleware as geoipMiddleware } from "./middlewares/ipMiddleware.ts";
import { ServiceContainer } from "./types/service.ts";
import { siteLookupMiddleware } from "./middlewares/siteLookupMiddleware.ts";
import { reverseProxyMiddleware } from "./middlewares/proxyMiddleware.ts";

/**
 * 构建代理服务器 Koa 应用（处理入站请求 + 挑战路由）。
 */
export function createProxyApp(
  cfg: AppConfig,
  services: ServiceContainer,
): Koa {
  const app = new Koa();

  app.proxy = true; // 启用代理信任，正确获取客户端 IP 等信息

  app.context.appConfig = cfg;

  // 加载规则引擎
  const ruleEngine = new RuleEngineService(app, cfg);
  console.log("[boot] Rules compiled successfully.");
  app.context.ruleEngine = ruleEngine;

  app.context.cacheService = services.cacheService;
  app.context.captchaService = services.captchaService;
  app.context.proxyService = services.proxyService;
  app.context.tpl = services.tpl;
  app.context.geoipService = services.geoipService;

  app.on("error", (err: Error) => {
    console.error("[proxy] unhandled error:", err.message);
    console.error(err);
  });

  app.use(errorMiddleware);
  app.use(bodyParser());

  app.use(geoipMiddleware);

  // 挑战路由（在防火墙之前注册，避免被拦截）
  registerProxyRoutes(app);

  // 防火墙 + 反向代理
  app.use(siteLookupMiddleware);
  app.use(firewallMiddleware);
  app.use(reverseProxyMiddleware);

  return app;
}

/**
 * 构建 API 服务器 Koa 应用（缓存管理等）。
 */
export function createApiApp(
  cfg: AppConfig,
  services: ServiceContainer,
): Koa {
  const app = new Koa();

  app.context.appConfig = cfg;

  app.context.cacheService = services.cacheService;
  app.context.captchaService = services.captchaService;
  app.context.proxyService = services.proxyService;
  app.context.tpl = services.tpl;
  app.context.geoipService = services.geoipService;

  app.on("error", (err: Error) => {
    console.error("[api] unhandled error:", err.message);
  });

  app.use(errorMiddleware);
  app.use(bodyParser());
  registerAdminRoutes(app);

  return app;
}
