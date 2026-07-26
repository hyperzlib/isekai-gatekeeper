import { createChallengeRouter, createStaticMiddleware } from "./challengeRoutes.ts";
import { createAdminRouter } from "./adminRoutes.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";

export function registerProxyRoutes(
  app: Hono<AppEnv>,
): void {
  createStaticMiddleware(app);
  createChallengeRouter(app);
}

export function registerAdminRoutes(
  app: Hono<AppEnv>,
): void {
  createAdminRouter(app);
}
