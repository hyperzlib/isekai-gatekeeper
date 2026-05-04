import type Koa from "koa";

/**
 * 全局错误处理中间件。
 * 捕获所有未处理的异常，返回统一错误格式。
 */
export const errorMiddleware: Koa.Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ??
      500;
    ctx.status = status;
    ctx.body = {
      error: status >= 500 ? "Internal Server Error" : error.message,
    };
    if (status >= 500) {
      ctx.app.emit("error", error, ctx);
    }
  }
};