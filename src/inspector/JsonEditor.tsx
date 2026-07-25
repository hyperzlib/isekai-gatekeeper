import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  isFocused: boolean;
  onChange: (value: string) => void;
}

export function JsonEditor({ value, isFocused, onChange }: Props): React.JSX.Element {
  const lines = useMemo(() => value.split("\n"), [value]);
  const [lineIndex, setLineIndex] = useState(0);

  useEffect(() => {
    setLineIndex((current) => Math.max(0, Math.min(current, Math.max(0, lines.length - 1))));
  }, [lines.length]);

  useInput((_input, key) => {
    if (!isFocused) return;
    if (key.upArrow) setLineIndex((current) => Math.max(0, current - 1));
    if (key.downArrow) setLineIndex((current) => Math.min(lines.length - 1, current + 1));
  }, { isActive: isFocused });

  const setLine = (nextLine: string): void => {
    const next = [...lines];
    next[lineIndex] = nextLine;
    onChange(next.join("\n"));
  };

  const insertLine = (): void => {
    const next = [...lines];
    next.splice(lineIndex + 1, 0, "");
    onChange(next.join("\n"));
    setLineIndex(lineIndex + 1);
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {lines.map((line, index) => (
        <Box key={index}>
          <Box width={4}>
            <Text color="gray">{index + 1}</Text>
          </Box>
          {index === lineIndex ? (
            <TextInput value={line} focus={isFocused} showCursor onChange={setLine} onSubmit={insertLine} />
          ) : (
            <Text>{line || " "}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
