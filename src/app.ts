import { Hono } from "hono";
import type { AppConfig } from "./types/config.ts";
import { RuleEngineService } from "./services/ruleEngineService.ts";
import { createErrorHandler } from "./middlewares/errorMiddleware.ts";
import { firewallMiddleware } from "./middlewares/firewallMiddleware.ts";
import { registerProxyRoutes, registerAdminRoutes } from "./routes/index.ts";
import { ipMiddleware as geoipMiddleware } from "./middlewares/ipMiddleware.ts";
import { ServiceContainer } from "./types/service.ts";
import { siteLookupMiddleware } from "./middlewares/siteLookupMiddleware.ts";
import { reverseProxyMiddleware } from "./middlewares/proxyMiddleware.ts";
import type { AppEnv } from "./types/hono.ts";

/**
 * 构建代理服务器 Hono 应用（处理入站请求 + 挑战路由）。
 */
export async function createProxyApp(
  cfg: AppConfig,
  services: ServiceContainer,
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();

  // 加载规则引擎
  const ruleEngine = new RuleEngineService(cfg, services.siteResolver);
  await ruleEngine.init();
  console.log("[boot] Rules compiled successfully.");

  app.onError(createErrorHandler("proxy"));
  app.use("*", async (ctx, next) => {
    ctx.set("appConfig", cfg);
    ctx.set("cacheService", services.cacheService);
    ctx.set("captchaService", services.captchaService);
    ctx.set("cleanupService", services.cleanupService);
    ctx.set("rateLimitService", services.rateLimitService);
    ctx.set("proxyService", services.proxyService);
    ctx.set("siteResolver", services.siteResolver);
    ctx.set("tpl", services.tpl);
    ctx.set("geoipService", services.geoipService);
    ctx.set("ruleEngine", ruleEngine);
    await next();
  });

  app.use("*", geoipMiddleware);

  // 挑战路由（在防火墙之前注册，避免被拦截）
  registerProxyRoutes(app);

  // 防火墙 + 反向代理
  app.use("*", siteLookupMiddleware);
  app.use("*", firewallMiddleware);
  app.use("*", reverseProxyMiddleware);

  return app;
}

/**
 * 构建 API 服务器 Hono 应用（缓存管理等）。
 */
export async function createApiApp(
  cfg: AppConfig,
  services: ServiceContainer,
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();

  app.onError(createErrorHandler("api"));
  app.use("*", async (ctx, next) => {
    ctx.set("appConfig", cfg);
    ctx.set("cacheService", services.cacheService);
    ctx.set("captchaService", services.captchaService);
    ctx.set("cleanupService", services.cleanupService);
    ctx.set("rateLimitService", services.rateLimitService);
    ctx.set("proxyService", services.proxyService);
    ctx.set("siteResolver", services.siteResolver);
    ctx.set("tpl", services.tpl);
    ctx.set("geoipService", services.geoipService);
    await next();
  });

  registerAdminRoutes(app);

  return app;
}
