#!/usr/bin/env bun

/**
 * 将 AppConfigSchema (Zod) 导出为 JSON Schema，用于为 config.toml 提供编辑器提示。
 *
 * 用法：
 *   bun cli/export-json-schema.ts            # 写入 schemas/config-schema.json
 *   bun cli/export-json-schema.ts --stdout   # 仅输出到 stdout
 *   bun run export-schema                     # npm script 快捷方式
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AppConfigSchema } from "../src/config/loadConfig.ts";

const STDOUT_ONLY = process.argv.includes("--stdout");

const jsonSchema = zodToJsonSchema(AppConfigSchema, {
  target: "jsonSchema7",
  $refStrategy: "none",
});

// 添加元数据
const result = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Isekai Gatekeeper — AppConfig",
  description:
    "isekai-gatekeeper 的 config.toml 完整 JSON Schema。配合 Even Better TOML 等 VS Code 插件可在编辑 config.toml 时提供自动补全与校验。",
  ...jsonSchema,
};

const outputJson = JSON.stringify(result, null, 2) + "\n";

if (STDOUT_ONLY) {
  process.stdout.write(outputJson);
} else {
  const outDir = resolve(import.meta.dirname!, "..", "schemas");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "config-schema.json");
  writeFileSync(outPath, outputJson, "utf-8");
  console.log(`✅ JSON Schema written to ${outPath}`);
}
