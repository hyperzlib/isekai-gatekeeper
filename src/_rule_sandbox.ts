import { Context } from "koa";
import { RulePresets } from "./utils/RulePresets";
import { CloudflareHttp } from "./types/cloudflare";
import { RuleRateLimit } from "./utils/RuleRateLimit";
import { RuleExpressionTools } from "./utils/RuleTools";

// 这个文件用于调试配置文件中的规则表达式
const evaluateRuleExpression = (
    ctx: Context,
    http: CloudflareHttp,
    presets: RulePresets,
    rateLimit: RuleRateLimit,
    state: Record<string, any>,
    match: RuleExpressionTools["match"],
    matchExtractGroup: RuleExpressionTools["matchExtractGroup"],
    matchGlob: RuleExpressionTools["matchGlob"],
    cacheTags: string[]
): any => {
    return false;
}