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
  matchExtractGroup: (str: string, pattern: RegExp | RegExp[], groupName: number | string = 1): string | null => {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];

    for (const p of patterns) {
      const m = p.exec(str);
      if (!m) continue;

      const value = typeof groupName === "string"
        ? (m.groups?.[groupName] ?? undefined)
        : m[groupName];

      if (value !== undefined) {
        return value;
      }
    }

    return null;
  }
}

export type RuleExpressionTools = typeof ruleExpressionTools;