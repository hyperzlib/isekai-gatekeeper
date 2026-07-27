import { RulePresets } from "./utils/RulePresets";
import { CloudflareHttp } from "./types/cloudflare";
import { RuleRateLimit } from "./utils/RuleRateLimit";
import { RuleExpressionUtils } from "./utils/RuleUtils";
import type { RuleContext } from "./types/hono";

// 这个文件用于调试配置文件中的规则表达式
const evaluateRuleExpression = (
    ctx: RuleContext,
    http: CloudflareHttp,
    presets: RulePresets,
    rateLimit: RuleRateLimit,
    utils: RuleExpressionUtils,
    state: Record<string, any>,
    cacheTags: string[]
): any => {
    return false;
}
