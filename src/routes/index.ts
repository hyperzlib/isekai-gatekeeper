import { createChallengeRouter, createStaticMiddleware } from "./challengeRoutes.ts";
import { createAdminRouter } from "./adminRoutes.ts";
import type Koa from "koa";

export function registerProxyRoutes(
  app: Koa,
): void {
  const challengeRouter = createChallengeRouter();
  app.use(createStaticMiddleware());
  app.use(challengeRouter.routes());
  app.use(challengeRouter.allowedMethods());
}

export function registerAdminRoutes(
  app: Koa,
): void {
  const adminRouter = createAdminRouter();
  app.use(adminRouter.routes());
  app.use(adminRouter.allowedMethods());
}
