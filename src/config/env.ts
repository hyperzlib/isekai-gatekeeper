/**
 * 从环境变量读取运行时覆盖值。
 * 优先级：环境变量 > 默认值
 */
export const env = {
  CONFIG_PATH: process.env["CONFIG_PATH"] ?? "config.ts",
} as const;
