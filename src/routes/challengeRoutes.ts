import Router from "@koa/router";
import serve from "koa-static";
import { getChallenge, verifyChallenge, renderChallengePage } from "../controllers/challengeController.ts";
import mount from "koa-mount";
import { bodyParser } from "@koa/bodyparser";

export const CHALLENGE_PATH_PREFIX = "/.isekai-gatekeeper";

export function createChallengeRouter(): Router {
  const router = new Router({ prefix: CHALLENGE_PATH_PREFIX });

  // 部分路由需要 bodyparser
  router.use(bodyParser());

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
