import Router from "@koa/router";
import {
  deleteCache,
  getRawCache,
  setRawCache,
  deleteRawCache,
  deleteRawCacheByPrefix,
  getRawCacheSize,
} from "../controllers/cacheController.ts";

export function createAdminRouter(): Router {
  const router = new Router({ prefix: "/api/v1" });

  router.post("/delete_cache", deleteCache);
  router.post("/cache/get", getRawCache);
  router.post("/cache/set", setRawCache);
  router.post("/cache/delete", deleteRawCache);
  router.post("/cache/delete_prefix", deleteRawCacheByPrefix);
  router.get("/cache/size", getRawCacheSize);

  return router;
}
