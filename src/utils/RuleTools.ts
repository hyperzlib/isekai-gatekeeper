import { match } from "path-to-regexp"

export const ruleExpressionTools = {
  matchGlob: (str: string, pattern: string | string[]): boolean => {
    if (Array.isArray(pattern)) {
      return pattern.some(p => match(p, { end: true })(str) !== false);
    } else {
      const matcher = match(pattern, { end: true });
      return matcher(str) !== false;
    }
  },
  match: (str: string, pattern: RegExp | RegExp[]): boolean => {
    if (Array.isArray(pattern)) {
      return pattern.some(p => p.test(str));
    } else {
      return pattern.test(str);
    }
  },
}

export type RuleExpressionTools = typeof ruleExpressionTools;