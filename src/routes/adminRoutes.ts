import Router from "@koa/router";
import { deleteCache } from "../controllers/cacheController.ts";

export function createAdminRouter(): Router {
  const router = new Router({ prefix: "/api/v1" });

  router.delete("/cache", deleteCache);

  return router;
}
