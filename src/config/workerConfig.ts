import { cpus } from "node:os";
import type { AppConfig } from "../types/config.ts";

export function validateWorkerConfig(
  cfg: AppConfig,
  platform = process.platform,
  cpuCount = cpus().length,
): number {
  const configured = cfg.proxy.workers ?? 1;
  const count = configured === "auto" ? (platform === "linux" ? cpuCount : 1) : configured;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("proxy.workers must be a positive integer or auto");
  }

  const proxyPort = cfg.proxy.server_port;
  const apiPort = cfg.api.server_port;
  if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error("proxy.server_port must be an integer between 1 and 65535");
  }
  if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error("api.server_port must be an integer between 1 and 65535");
  }

  if (count > 1 && cfg.cache.provider !== "bun+redis" && cfg.cache.provider !== "redis") {
    throw new Error("Multiple proxy workers requires cache.provider to be bun+redis or redis");
  }

  const lastProxyPort = platform === "linux" ? proxyPort : proxyPort + count - 1;
  if (lastProxyPort > 65535) {
    throw new Error("Proxy worker port range exceeds 65535");
  }
  if (apiPort >= proxyPort && apiPort <= lastProxyPort) {
    throw new Error("API port overlaps proxy worker port range");
  }

  return count;
}
