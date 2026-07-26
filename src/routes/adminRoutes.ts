import { deleteCache, listCachedPages } from "../controllers/cacheController.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";

export function createAdminRouter(app: Hono<AppEnv>): void {
  app.post("/api/v1/delete_cache", deleteCache);
  app.post("/api/v1/list_cached_pages", listCachedPages);
}
