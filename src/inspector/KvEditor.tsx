import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { KvMode } from "./types.ts";

interface KvRow {
  id: number;
  key: string;
  value: string;
}

type FocusColumn = "key" | "value";

interface Props {
  mode: KvMode;
  entries: Record<string, string>;
  height: number;
  onSave: (entries: Record<string, string>) => void;
  onCancel: () => void;
}

export function KvEditor({ mode, entries, height, onSave, onCancel }: Props): React.JSX.Element {
  const [rows, setRows] = useState<KvRow[]>(() => entriesToRows(entries));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusColumn, setFocusColumn] = useState<FocusColumn>("key");
  const [nextId, setNextId] = useState(() => Object.keys(entries).length);
  const listHeight = Math.max(3, height - 5);
  const addIndex = rows.length;

  useInput((input, key) => {
    if (key.escape) {
      saveRows();
      return;
    }
    if (isCancelInput(input, key)) {
      onCancel();
      return;
    }
    if (isDeleteRowInput(input, key) && selectedIndex < rows.length) {
      deleteSelectedRow();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(addIndex, current + 1));
      return;
    }
    if (key.tab) {
      setFocusColumn((current) => current === "key" ? "value" : "key");
      return;
    }
    if (key.return && selectedIndex === addIndex) {
      addEmptyRow();
    }
  }, { isActive: true });

  const saveRows = (): void => {
    onSave(rowsToEntries(rows));
  };

  const visibleRows = useMemo(() => {
    const allRows = [...rows, { id: -1, key: "Add", value: "" }];
    const offset = Math.max(0, Math.min(selectedIndex, allRows.length - 1) - listHeight + 1);
    return allRows.slice(offset, offset + listHeight).map((row, index) => ({ row, rowIndex: offset + index }));
  }, [listHeight, rows, selectedIndex]);

  function updateRow(rowIndex: number, patch: Partial<KvRow>): void {
    setRows((current) => current.map((row, index) => index === rowIndex ? { ...row, ...patch } : row));
  }

  function addEmptyRow(): void {
    const newRowIndex = rows.length;
    setRows((current) => [...current, { id: nextId, key: "", value: "" }]);
    setNextId((current) => current + 1);
    setSelectedIndex(newRowIndex);
    setFocusColumn("key");
  }

  function deleteSelectedRow(): void {
    setRows((current) => current.filter((_row, index) => index !== selectedIndex));
    setSelectedIndex((current) => Math.max(0, Math.min(current, rows.length - 1)));
  }

  return (
    <Box width="100%" height={height} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} overflow="hidden">
      <Text bold> Edit {mode === "headers" ? "Headers" : "Cookies"} </Text>
      <Box>
        <Box width="48%"><Text color="gray">Key</Text></Box>
        <Text color="gray">Value</Text>
      </Box>
      <Box flexDirection="column" height={listHeight} overflow="hidden">
        {visibleRows.map(({ row, rowIndex }) => {
          if (row.id === -1) {
            return (
              <Text key="add" backgroundColor={selectedIndex === addIndex ? "green" : undefined} color={selectedIndex === addIndex ? "black" : "cyan"}>
                {selectedIndex === addIndex ? "> " : "  "}Add
              </Text>
            );
          }

          const selected = rowIndex === selectedIndex;
          return (
            <Box key={row.id}>
              <Text color={selected ? "white" : undefined}>{selected ? "> " : "  "}</Text>
              <Box width="46%">
                <TextInput
                  value={row.key}
                  focus={selected && focusColumn === "key"}
                  showCursor
                  onChange={(keyValue) => updateRow(rowIndex, { key: keyValue })}
                  onSubmit={saveRows}
                />
              </Box>
              <Box width="52%">
                <TextInput
                  value={row.value}
                  focus={selected && focusColumn === "value"}
                  showCursor
                  onChange={(value) => updateRow(rowIndex, { value })}
                  onSubmit={saveRows}
                />
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text color="gray">↑↓:Row  Tab:Key/Value  Enter:Save/Add  Esc:Save  Ctrl+D:Delete  Ctrl+G:Cancel</Text>
    </Box>
  );
}

function entriesToRows(entries: Record<string, string>): KvRow[] {
  return Object.entries(entries).map(([key, value], index) => ({ id: index, key, value }));
}

function rowsToEntries(rows: KvRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    result[key] = row.value;
  }
  return result;
}

function isDeleteRowInput(input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && input.toLowerCase() === "d";
}

function isCancelInput(input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && input.toLowerCase() === "g";
}
