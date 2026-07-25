import type { DebugRequestConfig } from "./ruleDebugSupport.ts";

export type EditorMode = "simple" | "json";
export type FocusContext = "list" | "editor";
export type KvMode = "headers" | "cookies";
export type EditorButtonKey = KvMode | "userAgentPresets";

export type SimpleFocusItem =
  | { type: "field"; key: SimpleFieldKey }
  | { type: "button"; key: EditorButtonKey };

export type SimpleFieldKey =
  | "name"
  | "method"
  | "url"
  | "host"
  | "clientIp"
  | "countryCode"
  | "userAgent"
  | "bodyContentType";

export const SIMPLE_FOCUS_ITEMS: SimpleFocusItem[] = [
  { type: "field", key: "name" },
  { type: "field", key: "method" },
  { type: "field", key: "url" },
  { type: "field", key: "host" },
  { type: "field", key: "clientIp" },
  { type: "field", key: "countryCode" },
  { type: "field", key: "userAgent" },
  { type: "button", key: "userAgentPresets" },
  { type: "field", key: "bodyContentType" },
  { type: "button", key: "headers" },
  { type: "button", key: "cookies" },
];

export function getSimpleFieldValue(request: DebugRequestConfig, key: SimpleFieldKey): string {
  if (key === "countryCode") {
    return request.geoip && typeof request.geoip === "object" && "countryCode" in request.geoip
      ? String((request.geoip as Record<string, unknown>).countryCode ?? "")
      : "";
  }
  if (key === "userAgent") {
    return request.headers["user-agent"] ?? "";
  }
  return String(request[key] ?? "");
}

export function setSimpleFieldValue(
  request: DebugRequestConfig,
  key: SimpleFieldKey,
  value: string,
): DebugRequestConfig {
  if (key === "countryCode") {
    return {
      ...request,
      geoip: {
        ...(request.geoip ?? {}),
        countryCode: value,
      },
    };
  }
  if (key === "userAgent") {
    return {
      ...request,
      headers: {
        ...request.headers,
        "user-agent": value,
      },
    };
  }

  return {
    ...request,
    [key]: value,
  };
}
