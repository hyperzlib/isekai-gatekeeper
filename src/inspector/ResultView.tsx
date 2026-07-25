import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  content: string;
  height: number;
  onClose: () => void;
  onSave: () => void;
}

export function ResultView({ content, height, onClose, onSave }: Props): React.JSX.Element {
  const lines = useMemo(() => content.split("\n"), [content]);
  const [offset, setOffset] = useState(0);
  const windowSize = Math.max(3, height - 3);

  useInput((_input, key) => {
    if (key.escape) onClose();
    if (key.ctrl && _input.toLowerCase() === "o") onSave();
    if (key.upArrow) setOffset((current) => Math.max(0, current - 1));
    if (key.downArrow) setOffset((current) => Math.min(Math.max(0, lines.length - windowSize), current + 1));
    if (key.pageUp) setOffset((current) => Math.max(0, current - windowSize));
    if (key.pageDown) setOffset((current) => Math.min(Math.max(0, lines.length - windowSize), current + windowSize));
  }, { isActive: true });

  return (
    <Box width="100%" height={height} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} overflow="hidden">
      <Text bold> Result </Text>
      {lines.slice(offset, offset + windowSize).map((line, index) => (
        <Text key={`${offset}:${index}`}>{line || " "}</Text>
      ))}
      <Text color="gray">Esc:Close  Ctrl+O:Save result</Text>
    </Box>
  );
}
