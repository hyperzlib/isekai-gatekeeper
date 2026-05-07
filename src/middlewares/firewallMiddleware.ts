import type Koa from "koa";
import { clearChallengePassCookie } from "../services/tokenService.ts";
import { renderChallengePage } from "../controllers/challengeController.ts";
import { CHALLENGE_PATH_PREFIX } from "../routes/challengeRoutes.ts";
import { RuleActionReturn } from "../types/rule.ts";

export const handleReturnAction = (ctx: Koa.Context, returnData: RuleActionReturn) => {
  ctx.status = returnData.status ?? 200;
  if (returnData.headers) {
    for (const [k, v] of Object.entries(returnData.headers)) {
      ctx.set(k, v);
    }
  }

  if (typeof returnData.text === "string") {
    ctx.type = "text/plain; charset=utf-8";
    ctx.body = returnData.text;
  } else if (returnData.tpl) {
    // 模板渲染
    const tpl = ctx.tpl.create(returnData.tpl.id);
    if (returnData.tpl.data) {
      tpl.assignAll(returnData.tpl.data);
    }
    tpl.flush(ctx);
  }
};

/**
 * 主防火墙中间件，按规则决策链路处理请求。
 */
export const firewallMiddleware: Koa.Middleware = async (ctx, next) => {
  // 挑战路径直接透传（由 challengeRoutes 处理）
  if (ctx.path.startsWith(CHALLENGE_PATH_PREFIX)) {
    return next();
  }

  if (!ctx.currentSite || !ctx.decision) {
    ctx.status = 500;
    ctx.body = "Site configuration or decision missing";
    return;
  }

  const decision = ctx.decision;

  // block=true → 中止连接
  if (decision.block) {
    ctx.status = 444;
    ctx.body = "Blocked by firewall";
    return;
  }

  // return 不为空 → 返回指定内容
  if (decision.return) {
    const ret = decision.return
    handleReturnAction(ctx, ret);
    return;
  }

  // 浏览器挑战
  if (decision.browser_challenge?.enabled) {
    if (!ctx.validatedClientId || decision.browser_challenge.re_challenge) {
      if (decision.browser_challenge.re_challenge) {
        // 清除验证通过的 Cookie（如果有），强制重新挑战
        clearChallengePassCookie(ctx);
      }
      // 如果 validatedClientId 为null，说明未通过检测，显示挑战页面
      renderChallengePage(ctx);
      return;
    }
  }

  return next();
};