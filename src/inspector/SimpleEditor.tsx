import React from "react";
import { Box, Text } from "ink";
import { EditableText } from "./EditableText.tsx";
import type { DebugRequestConfig } from "./ruleDebugSupport.ts";
import { kvPreview } from "./format.ts";
import {
  getSimpleFieldValue,
  setSimpleFieldValue,
  SIMPLE_FOCUS_ITEMS,
  type SimpleFieldKey,
  type SimpleFocusItem,
} from "./types.ts";

const FIELD_LABELS: Record<SimpleFieldKey, string> = {
  name: "Name",
  method: "Method",
  url: "URL",
  host: "Host",
  clientIp: "Client IP",
  countryCode: "Country",
  userAgent: "User Agent",
  bodyContentType: "Body Type",
};

interface Props {
  request: DebugRequestConfig;
  focusIndex: number;
  onChange: (request: DebugRequestConfig) => void;
  onNext: () => void;
  onFocusUserAgentPresets: () => void;
}

export function SimpleEditor({ request, focusIndex, onChange, onNext, onFocusUserAgentPresets }: Props): React.JSX.Element {
  const presetIndex = SIMPLE_FOCUS_ITEMS.findIndex((item) => item.type === "button" && item.key === "userAgentPresets");
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {SIMPLE_FOCUS_ITEMS.map((item, index) => {
        if (item.type === "button" && item.key === "userAgentPresets") return null;
        return (
          <SimpleRow
            key={`${item.type}:${item.key}`}
            item={item}
            request={request}
            isFocused={index === focusIndex}
            isPresetFocused={presetIndex === focusIndex}
            onChange={onChange}
            onSubmit={onNext}
            onFocusUserAgentPresets={onFocusUserAgentPresets}
          />
        );
      })}
    </Box>
  );
}

interface RowProps {
  item: SimpleFocusItem;
  request: DebugRequestConfig;
  isFocused: boolean;
  isPresetFocused: boolean;
  onChange: (request: DebugRequestConfig) => void;
  onSubmit: () => void;
  onFocusUserAgentPresets: () => void;
}

function SimpleRow({
  item,
  request,
  isFocused,
  isPresetFocused,
  onChange,
  onSubmit,
  onFocusUserAgentPresets,
}: RowProps): React.JSX.Element {
  if (item.type === "button") {
    const entries = item.key === "headers" ? headersWithoutUserAgent(request.headers) : request.cookies;
    return (
      <Box marginBottom={1}>
        <Box width={14}>
          <Text>{item.key === "headers" ? "Headers:" : "Cookies:"}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color="cyan">{kvPreview(entries)}</Text>
        </Box>
        <Text backgroundColor={isFocused ? "green" : undefined} color={isFocused ? "black" : "white"}>
          {" Edit "}
        </Text>
      </Box>
    );
  }

  const label = FIELD_LABELS[item.key];
  return (
    <Box marginBottom={1}>
      <Box width={14}>
        <Text>{label}:</Text>
      </Box>
      <Box flexGrow={1}>
        <EditableText
          value={getSimpleFieldValue(request, item.key)}
          focus={isFocused}
          onChange={(value) => onChange(setSimpleFieldValue(request, item.key, value))}
          onSubmit={onSubmit}
          onRightAtEnd={item.key === "userAgent" ? onFocusUserAgentPresets : undefined}
        />
      </Box>
      {item.key === "userAgent" ? (
        <Text backgroundColor={isPresetFocused ? "green" : undefined} color={isPresetFocused ? "black" : "white"}>
          {" Presets "}
        </Text>
      ) : null}
    </Box>
  );
}

function headersWithoutUserAgent(headers: Record<string, string>): Record<string, string> {
  const { ["user-agent"]: _userAgent, ...rest } = headers;
  return rest;
}
