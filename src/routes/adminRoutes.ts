import Router from "@koa/router";
import { deleteCache, listCachedPages } from "../controllers/cacheController.ts";

export function createAdminRouter(): Router {
  const router = new Router({ prefix: "/api/v1" });

  router.post("/delete_cache", deleteCache);
  router.post("/list_cached_pages", listCachedPages);

  return router;
}
