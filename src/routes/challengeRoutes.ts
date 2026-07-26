import { getChallenge, verifyChallenge, renderChallengePage } from "../controllers/challengeController.ts";
import { serveStatic } from "hono/bun";
import type { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";

export const CHALLENGE_PATH_PREFIX = "/.isekai-gatekeeper";

export function createChallengeRouter(app: Hono<AppEnv>): void {
  app.get(`${CHALLENGE_PATH_PREFIX}/challenge`, getChallenge);
  app.post(`${CHALLENGE_PATH_PREFIX}/verify`, verifyChallenge);
  app.get(`${CHALLENGE_PATH_PREFIX}/`, renderChallengePage);
}

/**
 * 静态文件中间件，服务 src/public/ 目录。
 */
export function createStaticMiddleware(app: Hono<AppEnv>): void {
  app.use(
    `${CHALLENGE_PATH_PREFIX}/public/*`,
    serveStatic({
      root: "./public",
      rewriteRequestPath: (path) =>
        path.replace(`${CHALLENGE_PATH_PREFIX}/public`, "") || "/",
    }),
  );
}
