import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../../src/types/config.ts";
import { validateWorkerConfig } from "../../src/config/workerConfig.ts";
import baseConfig from "../config.ts";

function config(workers: number | "auto", provider: AppConfig["cache"]["provider"] = "bun+redis"): AppConfig {
  return {
    ...baseConfig,
    proxy: { server_port: 19080, workers },
    api: { ...baseConfig.api, server_port: 19081 },
    cache: { ...baseConfig.cache, provider },
  };
}

describe("proxy worker configuration", () => {
  it("uses CPU count on Linux and one worker on Windows/macOS for auto", () => {
    expect(validateWorkerConfig(config("auto"), "linux", 6)).toBe(6);
    expect(validateWorkerConfig(config("auto", "memory"), "win32", 8)).toBe(1);
    expect(validateWorkerConfig(config("auto", "memory"), "darwin", 8)).toBe(1);
    expect(validateWorkerConfig(config("auto", "memory"), "linux", 1)).toBe(1);
    expect(() => validateWorkerConfig(config("auto", "memory"), "linux", 6)).toThrow("requires cache.provider");
  });

  it("keeps the default single process with memory storage", () => {
    expect(validateWorkerConfig({ ...baseConfig, proxy: { server_port: 19080 } }, "win32")).toBe(1);
  });

  it("requires shared storage for multiple workers", () => {
    expect(() => validateWorkerConfig(config(2, "memory"), "win32")).toThrow("requires cache.provider");
  });

  it("reserves every Windows and macOS proxy port and only one Linux port", () => {
    expect(() => validateWorkerConfig(config(2), "win32")).toThrow("overlaps");
    expect(() => validateWorkerConfig(config(2), "darwin")).toThrow("overlaps");
    expect(validateWorkerConfig(config(2), "linux")).toBe(2);
  });

  it("rejects invalid counts and overflowing port ranges", () => {
    expect(() => validateWorkerConfig(config(0), "win32")).toThrow("positive integer");
    const overflowing = { ...config(3), proxy: { server_port: 65534, workers: 3 }, api: { ...baseConfig.api, server_port: 19081 } };
    expect(() => validateWorkerConfig(overflowing, "win32")).toThrow("exceeds 65535");
    expect(() => validateWorkerConfig(overflowing, "darwin")).toThrow("exceeds 65535");
  });
});
