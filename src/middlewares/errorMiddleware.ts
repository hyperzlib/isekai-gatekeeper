import type { ErrorHandler } from "hono";
import type { AppEnv } from "../types/hono.ts";

/**
 * 全局错误处理中间件。
 * 捕获所有未处理的异常，返回统一错误格式。
 */
export function createErrorHandler(label: string): ErrorHandler<AppEnv> {
  return (err, ctx) => {
    const error = err instanceof Error ? err : new Error(String(err));
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ??
      500;

    if (status >= 500) {
      console.error(`[${label}] unhandled error:`, error.message);
      console.error(error);
    }

    return new Response(JSON.stringify({
      error: status >= 500 ? "Internal Server Error" : error.message,
    }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}
