import type { MiddlewareHandler } from "hono";
import { clearChallengePassCookie } from "../services/tokenService.ts";
import { renderChallengePage } from "../controllers/challengeController.ts";
import { CHALLENGE_PATH_PREFIX } from "../routes/challengeRoutes.ts";
import type { ResolvedReturn } from "../types/decision.ts";
import type { AppContext, AppEnv } from "../types/hono.ts";

function textResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const handleReturnAction = (ctx: AppContext, returnData: ResolvedReturn): Response => {
  const status = returnData.status ?? 200;
  const headers = new Headers(returnData.headers);

  if (typeof returnData.text === "string") {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(returnData.text, { status, headers });
  }

  if (returnData.tpl) {
    const tpl = ctx.get("tpl").create(returnData.tpl.id);
    if (returnData.tpl.data) {
      tpl.assignAll(returnData.tpl.data);
    }
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(tpl.render(), { status, headers });
  }

  return new Response(null, { status, headers });
};

export const firewallMiddleware: MiddlewareHandler<AppEnv> = async (ctx, next) => {
  if (ctx.req.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    await next();
    return;
  }

  const currentSite = ctx.get("currentSite");
  const decision = ctx.get("decision");
  if (!currentSite || !decision) {
    return textResponse("Site configuration or decision missing", 500);
  }

  if (decision.block) {
    return textResponse("Blocked by firewall", 444);
  }

  if (decision.return) {
    return handleReturnAction(ctx, decision.return);
  }

  if (decision.browser_challenge?.enabled) {
    if (!ctx.get("validatedClientId") || decision.browser_challenge.re_challenge) {
      if (decision.browser_challenge.re_challenge) {
        clearChallengePassCookie(ctx);
      }
      return renderChallengePage(ctx);
    }
  }

  await next();
};
