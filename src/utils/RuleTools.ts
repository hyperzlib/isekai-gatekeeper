import { match } from "path-to-regexp"

export const ruleExpressionTools = {
  matchGlob: (str: string, pattern: string): boolean => {
    const matcher = match(pattern, { end: true });
    return matcher(str) !== false;
  },
  match: (str: string, pattern: RegExp): boolean => {
    return pattern.test(str);
  }
}

export type RuleExpressionTools = typeof ruleExpressionTools;