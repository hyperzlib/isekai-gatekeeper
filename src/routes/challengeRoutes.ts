import Router from "@koa/router";
import serve from "koa-static";
import { join } from "node:path";
import { getChallenge, verifyChallenge, renderChallengePage } from "../controllers/challengeController.ts";
import mount from "koa-mount";

export function createChallengeRouter(): Router {
  const router = new Router({ prefix: "/.isekai-gatekeeper" });

  router.get("/challenge", getChallenge);
  router.post("/verify", verifyChallenge);
  router.get("/", renderChallengePage);

  return router;
}

/**
 * 静态文件中间件，服务 src/public/ 目录。
 */
export function createStaticMiddleware() {
  return mount('/.isekai-gatekeeper/public',
    serve("./public", { index: false }));
}
