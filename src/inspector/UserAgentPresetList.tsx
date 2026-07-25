import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { USER_AGENT_PRESETS, type UserAgentPreset } from "./userAgentPresets.ts";

interface Props {
  height: number;
  onSelect: (preset: UserAgentPreset) => void;
  onCancel: () => void;
}

export function UserAgentPresetList({ height, onSelect, onCancel }: Props): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listHeight = Math.max(3, height - 3);
  const offset = Math.max(0, selectedIndex - listHeight + 1);
  const visiblePresets = USER_AGENT_PRESETS.slice(offset, offset + listHeight);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSelect(USER_AGENT_PRESETS[selectedIndex]!);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(USER_AGENT_PRESETS.length - 1, current + 1));
    }
  }, { isActive: true });

  return (
    <Box width="100%" height={height} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} overflow="hidden">
      <Text bold> User Agent Presets </Text>
      <Box flexDirection="column" height={listHeight} overflow="hidden">
        {visiblePresets.map((preset, index) => {
          const absoluteIndex = offset + index;
          const selected = absoluteIndex === selectedIndex;
          return (
            <Text key={preset.description} backgroundColor={selected ? "blue" : undefined} color={selected ? "white" : undefined}>
              {selected ? "> " : "  "}
              {preset.description}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">↑↓:Select  Enter:Use  Esc:Cancel</Text>
    </Box>
  );
}
