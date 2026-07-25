import type { RuleTraceEvent } from "../types/rule.ts";

export function formatResult(trace: RuleTraceEvent[], decision: unknown, siteFound: boolean): string {
  const traceLines = trace.map(formatTraceEvent).join("\n");
  return [
    `siteFound: ${siteFound}`,
    "",
    "TRACE",
    traceLines || "(no trace events)",
    "",
    "DECISION",
    stringifyForDisplay(decision),
  ].join("\n");
}

function formatTraceEvent(event: RuleTraceEvent): string {
  switch (event.type) {
    case "site":
      return `[site] host=${event.hostname} matched=${event.matched}`;
    case "rule_condition_start":
      return `[condition:start] ${event.ruleId}${event.description ? ` - ${event.description}` : ""}`;
    case "rule_condition_result":
      return `[condition:result] ${event.ruleId} matched=${event.matched}`;
    case "rule_condition_error":
      return `[condition:error] ${event.ruleId} ${formatError(event.error)}`;
    case "rule_exec_start":
      return `[exec:start] ${event.ruleId}`;
    case "rule_exec_done":
      return `[exec:done] ${event.ruleId}`;
    case "rule_exec_error":
      return `[exec:error] ${event.ruleId} ${formatError(event.error)}`;
    case "rule_action":
      return `[action] ${event.ruleId} ${stringifyForDisplay(event.action)}`;
    case "rule_stop":
      return `[stop] ${event.ruleId} reason=${event.reason}`;
    case "cache_tags_callback_start":
      return `[cache-tags:start] ${event.source}${event.ruleId ? ` ${event.ruleId}` : ""}`;
    case "cache_tags_callback_result":
      return `[cache-tags:result] ${event.source}${event.ruleId ? ` ${event.ruleId}` : ""} tags=${JSON.stringify(event.tags)}`;
    case "cache_tags_callback_error":
      return `[cache-tags:error] ${event.source}${event.ruleId ? ` ${event.ruleId}` : ""} ${formatError(event.error)}`;
    case "default_decision":
      return `[default] ${stringifyForDisplay(event.decision)}`;
    case "final_decision":
      return `[final] ${stringifyForDisplay(event.decision)}`;
  }
}

export function stringifyForDisplay(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
    if (item instanceof Error) return `${item.name}: ${item.message}`;
    return item;
  }, 2);
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function kvPreview(entries: Record<string, string>): string {
  const keys = Object.keys(entries);
  if (keys.length === 0) return "(empty)";
  const first = keys[0]!;
  const rest = keys.length > 1 ? ` +${keys.length - 1} more` : "";
  const val = (entries[first] ?? "").slice(0, 32);
  return `${first}: ${val}${rest}`;
}
