import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { RequestList } from "./RequestList.tsx";
import { SimpleEditor } from "./SimpleEditor.tsx";
import { JsonEditor } from "./JsonEditor.tsx";
import { KvEditor } from "./KvEditor.tsx";
import { ResultView } from "./ResultView.tsx";
import { UserAgentPresetList } from "./UserAgentPresetList.tsx";
import { formatError, formatResult } from "./format.ts";
import {
  createDebugRuntime,
  createDefaultRequest,
  evaluateDebugRequest,
  loadDebugHistory,
  normalizeRequest,
  saveDebugHistory,
  type DebugCacheMode,
  type DebugHistoryFile,
  type DebugRequestConfig,
  type DebugRuntime,
} from "./ruleDebugSupport.ts";
import { SIMPLE_FOCUS_ITEMS, type EditorMode, type FocusContext, type KvMode } from "./types.ts";

const configPath = resolve(process.env["CONFIG_PATH"] ?? "config.ts");
const RESULT_SAVE_PATH = resolve("data", "rule-debug-result.json");
const isMac = process.platform === "darwin";
const reloadLabel = isMac ? "F5/Cmd+R" : "F5/Ctrl+R";
const saveLabel = isMac ? "Cmd+S" : "Ctrl+S";
const runLabel = "F10/Ctrl+E";

type ModalState =
  | { type: "none" }
  | { type: "kv"; mode: KvMode; entries: Record<string, string> }
  | { type: "userAgentPresets" }
  | { type: "result"; content: string };

interface InputKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
}

export function App(): React.JSX.Element {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { columns, rows } = useWindowSize();
  const [history, setHistory] = useState<DebugHistoryFile>(() => loadDebugHistory());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusContext, setFocusContext] = useState<FocusContext>("list");
  const [editorMode, setEditorMode] = useState<EditorMode>("simple");
  const [simpleFocusIndex, setSimpleFocusIndex] = useState(0);
  const [jsonDraft, setJsonDraft] = useState("");
  const [cacheMode, setCacheMode] = useState<DebugCacheMode>("memory");
  const [runtime, setRuntime] = useState<DebugRuntime | null>(null);
  const [status, setStatus] = useState("Loading config...");
  const [modal, setModal] = useState<ModalState>({ type: "none" });

  const currentRequest = history.requests[selectedIndex] ?? createDefaultRequest();

  useEffect(() => {
    void reloadConfig(cacheMode);
  }, []);

  useEffect(() => {
    const handleRawInput = (data: Buffer): void => {
      const sequence = data.toString("utf-8");
      if (modal.type !== "none") return;
      if (isRawF10(sequence)) {
        void runCurrentRequest();
        return;
      }
      if (isRawF5(sequence)) {
        void reloadConfig(cacheMode);
      }
    };

    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
    };
  }, [cacheMode, modal.type, runCurrentRequest, reloadConfig, stdin]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "x") {
      exit();
      return;
    }

    if (modal.type !== "none") return;

    if (isRunKey(input, key)) {
      void runCurrentRequest();
      return;
    }
    if (isSaveKey(input, key)) {
      saveHistoryToDisk();
      return;
    }
    if (isReloadKey(input, key)) {
      void reloadConfig(cacheMode);
      return;
    }

    if (focusContext === "list") {
      handleListInput(input, key);
      return;
    }

    handleEditorInput(key);
  });

  const updateCurrentRequest = (request: DebugRequestConfig): void => {
    setHistory((current) => withRequest(current, selectedIndex, request, false));
  };

  const switchEditorMode = (mode: EditorMode): void => {
    if (mode === editorMode) return;
    const committed = getCurrentRequestFromEditor();
    if (!committed) return;

    setHistory((current) => withRequest(current, selectedIndex, committed));
    if (mode === "json") {
      setJsonDraft(`${JSON.stringify(committed, null, 2)}\n`);
    }
    setEditorMode(mode);
  };

  const openKvEditor = (mode: KvMode): void => {
    const committed = getCurrentRequestFromEditor();
    if (!committed) return;
    setHistory((current) => withRequest(current, selectedIndex, committed));
    setModal({
      type: "kv",
      mode,
      entries: { ...(mode === "headers" ? headersWithoutUserAgent(committed.headers) : committed.cookies) },
    });
  };

  const saveKvEditor = (entries: Record<string, string>): void => {
    if (modal.type !== "kv") return;
    const userAgent = currentRequest.headers["user-agent"];
    const nextHeaders = modal.mode === "headers" && userAgent !== undefined
      ? { ...entries, "user-agent": userAgent }
      : entries;
    const nextRequest = {
      ...currentRequest,
      [modal.mode]: { ...(modal.mode === "headers" ? nextHeaders : entries) },
    };
    updateCurrentRequest(nextRequest);
    setModal({ type: "none" });
  };

  const saveUserAgentPreset = (value: string): void => {
    updateCurrentRequest({
      ...currentRequest,
      headers: {
        ...currentRequest.headers,
        "user-agent": value,
      },
    });
    setModal({ type: "none" });
  };

  async function reloadConfig(nextCacheMode: DebugCacheMode): Promise<void> {
    try {
      const nextRuntime = await createDebugRuntime(configPath, nextCacheMode);
      setRuntime(nextRuntime);
      setStatus(`Config loaded: ${configPath} | cache=${nextCacheMode}`);
    } catch (err) {
      setRuntime(null);
      setStatus(`Config reload failed: ${formatError(err)}`);
    }
  }

  async function runCurrentRequest(): Promise<void> {
    const request = getCurrentRequestFromEditor();
    if (!request) return;
    setHistory((current) => withRequest(current, selectedIndex, request));

    let activeRuntime = runtime;
    if (!activeRuntime) {
      try {
        activeRuntime = await createDebugRuntime(configPath, cacheMode);
        setRuntime(activeRuntime);
      } catch (err) {
        setStatus(`Config reload failed: ${formatError(err)}`);
        return;
      }
    }

    try {
      const result = await evaluateDebugRequest(activeRuntime, request);
      const content = formatResult(result.trace, result.decision, result.siteFound);
      setModal({ type: "result", content });
      setStatus(`Ran "${request.name}" | site=${result.siteFound ? "matched" : "missing"} | cache=${cacheMode}`);
    } catch (err) {
      setStatus(`Run failed: ${formatError(err)}`);
    }
  }

  function saveHistoryToDisk(): void {
    const request = getCurrentRequestFromEditor();
    if (!request) return;
    const nextHistory = withRequest(history, selectedIndex, request);
    setHistory(nextHistory);
    try {
      saveDebugHistory(nextHistory);
      setStatus("Saved data/rule-debug.json");
    } catch (err) {
      setStatus(`Save failed: ${formatError(err)}`);
    }
  }

  function saveResultToFile(content: string): void {
    try {
      writeFileSync(RESULT_SAVE_PATH, `${content}\n`, "utf-8");
      setStatus(`Result saved to ${RESULT_SAVE_PATH}`);
    } catch (err) {
      setStatus(`Save result failed: ${formatError(err)}`);
    }
  }

  function getCurrentRequestFromEditor(): DebugRequestConfig | null {
    if (editorMode === "simple") return normalizeRequest(currentRequest);
    try {
      return normalizeRequest(JSON.parse(jsonDraft) as Partial<DebugRequestConfig>);
    } catch {
      setStatus("Invalid request JSON");
      return null;
    }
  }

  function handleListInput(input: string, key: InputKey): void {
    if (key.upArrow) {
      const nextIndex = Math.max(0, selectedIndex - 1);
      setSelectedIndex(nextIndex);
      if (editorMode === "json") setJsonDraft(`${JSON.stringify(history.requests[nextIndex], null, 2)}\n`);
      return;
    }
    if (key.downArrow) {
      const nextIndex = Math.min(history.requests.length - 1, selectedIndex + 1);
      setSelectedIndex(nextIndex);
      if (editorMode === "json") setJsonDraft(`${JSON.stringify(history.requests[nextIndex], null, 2)}\n`);
      return;
    }
    if (key.return) {
      setFocusContext("editor");
      setSimpleFocusIndex(0);
      if (editorMode === "json") setJsonDraft(`${JSON.stringify(currentRequest, null, 2)}\n`);
      return;
    }
    if (input === "n") {
      const source = history.requests[selectedIndex];
      const next = normalizeRequest(source ? { ...source, name: `${source.name || "Request"} copy` } : createDefaultRequest());
      setHistory({ requests: [...history.requests, next] });
      setSelectedIndex(history.requests.length);
      setStatus("Created request");
      return;
    }
    if (input === "d") {
      if (history.requests.length <= 1) {
        setHistory({ requests: [createDefaultRequest()] });
        setSelectedIndex(0);
      } else {
        const nextRequests = history.requests.filter((_request, index) => index !== selectedIndex);
        setHistory({ requests: nextRequests });
        setSelectedIndex(Math.max(0, Math.min(selectedIndex, nextRequests.length - 1)));
      }
      setStatus("Deleted request");
      return;
    }
    if (input === "m") {
      const nextCacheMode = cacheMode === "memory" ? "config" : "memory";
      setCacheMode(nextCacheMode);
      void reloadConfig(nextCacheMode);
    }
  }

  function handleEditorInput(key: InputKey): void {
    if (key.escape) {
      const committed = getCurrentRequestFromEditor();
      if (!committed) return;
      setHistory((current) => withRequest(current, selectedIndex, committed));
      setFocusContext("list");
      return;
    }
    if (key.tab) {
      switchEditorMode(editorMode === "simple" ? "json" : "simple");
      return;
    }
    if (editorMode !== "simple") return;

    if (key.leftArrow || key.rightArrow) {
      const currentItem = SIMPLE_FOCUS_ITEMS[simpleFocusIndex];
      if (key.leftArrow && currentItem?.type === "button" && currentItem.key === "userAgentPresets") {
        focusSimpleItem("field", "userAgent");
        return;
      }
    }

    if (key.upArrow) {
      setSimpleFocusIndex((current) => (current - 1 + SIMPLE_FOCUS_ITEMS.length) % SIMPLE_FOCUS_ITEMS.length);
      return;
    }
    if (key.downArrow) {
      setSimpleFocusIndex((current) => (current + 1) % SIMPLE_FOCUS_ITEMS.length);
      return;
    }
    if (key.return) {
      const item = SIMPLE_FOCUS_ITEMS[simpleFocusIndex];
      if (item?.type === "button") {
        if (item.key === "userAgentPresets") {
          setModal({ type: "userAgentPresets" });
        } else {
          openKvEditor(item.key);
        }
      }
    }
  }

  function focusSimpleItem(type: "field" | "button", key: string): void {
    const nextIndex = SIMPLE_FOCUS_ITEMS.findIndex((item) => item.type === type && item.key === key);
    if (nextIndex !== -1) setSimpleFocusIndex(nextIndex);
  }

  const shortcutHints = focusContext === "list"
    ? `Enter:编辑  N:新建  D:删除  ${runLabel}:运行  ${saveLabel}:保存  ${reloadLabel}:重载  M:缓存  Ctrl+X:退出`
    : `Esc:返回列表  ↑↓:切换字段  Tab:切换编辑器  Enter:编辑  ${runLabel}:运行  ${saveLabel}:保存  ${reloadLabel}:重载  Ctrl+X:退出`;
  const layoutWidth = Math.max(60, columns);
  const layoutHeight = Math.max(16, rows);
  const statusHeight = 3;
  const hintsHeight = 1;
  const mainHeight = Math.max(8, layoutHeight - statusHeight - hintsHeight);
  const modalWidthRatio = modal.type === "result" ? 0.94 : 0.78;
  const modalHeightRatio = modal.type === "result" ? 0.86 : 0.62;
  const modalWidth = Math.min(Math.max(48, Math.floor(layoutWidth * modalWidthRatio)), layoutWidth - 4);
  const modalHeight = Math.min(Math.max(10, Math.floor(layoutHeight * modalHeightRatio)), layoutHeight - 4);
  const modalLeft = Math.max(1, Math.floor((layoutWidth - modalWidth) / 2));
  const modalTop = Math.max(1, Math.floor((layoutHeight - modalHeight) / 2));

  return (
    <Box width={layoutWidth} height={layoutHeight} flexDirection="column" overflow="hidden">
      <Box height={mainHeight}>
        <RequestList requests={history.requests} selectedIndex={selectedIndex} isFocused={focusContext === "list"} />
        <Box width="72%" height="100%" borderStyle="single" borderColor={focusContext === "editor" ? "green" : "cyan"} flexDirection="column">
          <Box paddingX={1}>
            <Text backgroundColor={editorMode === "simple" ? "blue" : undefined} color={editorMode === "simple" ? "white" : undefined}> Simple </Text>
            <Text>  </Text>
            <Text backgroundColor={editorMode === "json" ? "blue" : undefined} color={editorMode === "json" ? "white" : undefined}> JSON </Text>
          </Box>
          {editorMode === "simple" ? (
            <SimpleEditor
              request={currentRequest}
              focusIndex={focusContext === "editor" ? simpleFocusIndex : -1}
              onChange={updateCurrentRequest}
              onNext={() => setSimpleFocusIndex((current) => (current + 1) % SIMPLE_FOCUS_ITEMS.length)}
              onFocusUserAgentPresets={() => focusSimpleItem("button", "userAgentPresets")}
            />
          ) : (
            <JsonEditor value={jsonDraft} isFocused={focusContext === "editor"} onChange={setJsonDraft} />
          )}
        </Box>
      </Box>
      <Text>{shortcutHints}</Text>
      <Box borderStyle="single" borderColor="gray" height={3}>
        <Text> {status}</Text>
      </Box>
      {modal.type !== "none" ? (
        <Backdrop left={0} top={0} width={layoutWidth} height={layoutHeight} />
      ) : null}
      {modal.type === "kv" ? (
        <Box position="absolute" left={modalLeft} top={modalTop} width={modalWidth} height={modalHeight}>
          <Backdrop left={0} top={0} width={modalWidth} height={modalHeight} />
          <KvEditor
            mode={modal.mode}
            entries={modal.entries}
            height={modalHeight}
            onSave={saveKvEditor}
            onCancel={() => setModal({ type: "none" })}
          />
        </Box>
      ) : null}
      {modal.type === "result" ? (
        <Box position="absolute" left={modalLeft} top={modalTop} width={modalWidth} height={modalHeight}>
          <Backdrop left={0} top={0} width={modalWidth} height={modalHeight} />
          <ResultView
            content={modal.content}
            height={modalHeight}
            onClose={() => setModal({ type: "none" })}
            onSave={() => saveResultToFile(modal.content)}
          />
        </Box>
      ) : null}
      {modal.type === "userAgentPresets" ? (
        <Box position="absolute" left={modalLeft} top={modalTop} width={modalWidth} height={modalHeight}>
          <Backdrop left={0} top={0} width={modalWidth} height={modalHeight} />
          <UserAgentPresetList
            height={modalHeight}
            onSelect={(preset) => saveUserAgentPreset(preset.value)}
            onCancel={() => setModal({ type: "none" })}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function headersWithoutUserAgent(headers: Record<string, string>): Record<string, string> {
  const { ["user-agent"]: _userAgent, ...rest } = headers;
  return rest;
}

function Backdrop({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): React.JSX.Element {
  const line = ".".repeat(Math.max(0, width));
  return (
    <Box position="absolute" left={left} top={top} width={width} height={height} flexDirection="column" overflow="hidden">
      {Array.from({ length: Math.max(0, height) }, (_item, index) => (
        <Text key={index} color="black" backgroundColor="black">{line}</Text>
      ))}
    </Box>
  );
}

function withRequest(
  history: DebugHistoryFile,
  index: number,
  request: DebugRequestConfig,
  normalize = true,
): DebugHistoryFile {
  const requests = [...history.requests];
  requests[index] = normalize ? normalizeRequest(request) : request;
  return { requests };
}

function isRunKey(input: string, key: InputKey): boolean {
  return (key.ctrl && input.toLowerCase() === "e") || isRawF10(input);
}

function isSaveKey(input: string, key: InputKey): boolean {
  return (key.ctrl && input.toLowerCase() === "s") || (isMac && key.meta && input.toLowerCase() === "s");
}

function isReloadKey(input: string, key: InputKey): boolean {
  return (key.ctrl && input.toLowerCase() === "r") || (isMac && key.meta && input.toLowerCase() === "r") || isRawF5(input);
}

function isRawF5(input: string): boolean {
  return input === "\u001b[15~" || input === "[15~" || input === "\u001b[[E" || input === "[[E";
}

function isRawF10(input: string): boolean {
  return input === "\u001b[21~" || input === "[21~";
}
