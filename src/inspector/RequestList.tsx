import React from "react";
import { Box, Text } from "ink";
import type { DebugRequestConfig } from "./ruleDebugSupport.ts";

interface Props {
  requests: DebugRequestConfig[];
  selectedIndex: number;
  isFocused: boolean;
}

export function RequestList({ requests, selectedIndex, isFocused }: Props): React.JSX.Element {
  return (
    <Box width="28%" height="100%" borderStyle="single" borderColor={isFocused ? "green" : "cyan"} flexDirection="column">
      <Text bold> Requests </Text>
      {requests.map((request, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={`${index}:${request.name}`} color={selected ? "white" : undefined} backgroundColor={selected ? "blue" : undefined}>
            {selected ? "> " : "  "}
            {request.name || "(unnamed)"}
          </Text>
        );
      })}
    </Box>
  );
}
