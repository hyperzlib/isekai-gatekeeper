import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";

interface Props {
  value: string;
  focus: boolean;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onRightAtEnd?: () => void;
}

export function EditableText({
  value,
  focus,
  onChange,
  onSubmit,
  onRightAtEnd,
}: Props): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((current) => Math.max(0, Math.min(current, value.length)));
  }, [value]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c")) return;
    if (key.return) {
      onSubmit?.();
      return;
    }
    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (key.rightArrow) {
      if (cursorOffset >= value.length) {
        onRightAtEnd?.();
        return;
      }
      setCursorOffset((current) => Math.min(value.length, current + 1));
      return;
    }
    if (key.backspace) {
      if (cursorOffset === 0) return;
      onChange(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset));
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (key.delete) {
      if (cursorOffset >= value.length) return;
      onChange(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
      return;
    }
    if (key.ctrl || key.meta || !input) return;

    onChange(value.slice(0, cursorOffset) + input + value.slice(cursorOffset));
    setCursorOffset((current) => current + input.length);
  }, { isActive: focus });

  return <Text>{renderValue(value, cursorOffset, focus)}</Text>;
}

function renderValue(value: string, cursorOffset: number, focus: boolean): React.ReactNode {
  if (!focus) return value || " ";

  if (value.length === 0) {
    return <Text inverse> </Text>;
  }

  const before = value.slice(0, cursorOffset);
  const cursorChar = value[cursorOffset];
  const after = value.slice(cursorOffset + 1);

  if (cursorChar === undefined) {
    return (
      <>
        {before}
        <Text inverse> </Text>
      </>
    );
  }

  return (
    <>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </>
  );
}
