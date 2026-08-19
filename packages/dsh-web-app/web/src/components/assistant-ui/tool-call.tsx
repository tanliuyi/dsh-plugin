"use client";

import { useEffect, useState } from "react";
import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { TerminalBlock } from "@/components/elements/terminal-block";
import { ToolCall } from "@/components/elements/tool-call";
import { terminalToolDataOf } from "@/lib/terminal-tool";

const TOOL_ACTIONS: Record<
  string,
  { label: string; activeLabel: string }
> = {
  read: { label: "Read", activeLabel: "Reading" },
  write: { label: "Wrote", activeLabel: "Writing" },
  edit: { label: "Edited", activeLabel: "Editing" },
  glob: { label: "Found", activeLabel: "Finding" },
  grep: { label: "Searched", activeLabel: "Searching" },
  find: { label: "Found", activeLabel: "Finding" },
  ls: { label: "Listed", activeLabel: "Listing" },
  bash: { label: "Ran", activeLabel: "Running" },
  pwsh: { label: "Ran", activeLabel: "Running" },
  web_search: { label: "Searched", activeLabel: "Searching" },
  read_image: { label: "Viewed", activeLabel: "Viewing" },
  subagent: { label: "Delegated", activeLabel: "Delegating" },
  subagent_fork: { label: "Delegated", activeLabel: "Delegating" },
  subagent_wait: { label: "Waited", activeLabel: "Waiting" },
  workflow: { label: "Orchestrated", activeLabel: "Orchestrating" },
  memory_search: { label: "Searched", activeLabel: "Searching" },
  memory_add: { label: "Updated", activeLabel: "Updating" },
  memory_replace: { label: "Updated", activeLabel: "Updating" },
  memory_remove: { label: "Updated", activeLabel: "Updating" },
  session_search: { label: "Searched", activeLabel: "Searching" },
};

const QUERY_KEYS = [
  "file_path",
  "path",
  "pattern",
  "query",
  "command",
  "url",
  "name",
  "task",
  "objective",
  "message",
] as const;

function parseJsonLayers(text: string): unknown {
  let value: unknown = text;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value !== "string") return value;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return text;
    }
  }
  return value;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function requestTextOf(argsText: string | undefined): string {
  if (!argsText) return "{}";
  const parsed = parseJsonLayers(argsText);
  return stringifyToolValue(parsed);
}

function shortenQuery(value: string): string {
  const trimmed = value.trim();
  return trimmed;
}

function queryOf(toolName: string, argsText: string | undefined): string {
  if (!argsText) return toolName;
  const parsed = parseJsonLayers(argsText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return toolName;
  }

  const args = parsed as Record<string, unknown>;
  for (const key of QUERY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return shortenQuery(value);
    }
  }
  return toolName;
}

function actionOf(toolName: string): { label: string; activeLabel: string } {
  return TOOL_ACTIONS[toolName] ?? { label: "Used", activeLabel: "Using" };
}

function resultTextOf(
  result: unknown,
  status: ToolCallMessagePartStatus | undefined,
  isError: boolean | undefined,
): string {
  if (result !== undefined) return stringifyToolValue(result);
  if (status?.type === "running") return "Waiting for result...";
  if (isError || status?.type === "incomplete") return "Tool failed.";
  return "No result";
}

/** Default assistant-ui tool part renderer backed by the Elements ToolCall. */
export const AssistantToolCall: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  isError,
}) => {
  const [open, setOpen] = useState(false);
  const running = status?.type === "running";
  const success =
    !isError && (status === undefined || status.type === "complete");
  const action = actionOf(toolName);
  const terminal = terminalToolDataOf(
    toolName,
    argsText,
    result,
    status?.type,
    isError,
  );

  useEffect(() => {
    if (status?.type === "requires-action") setOpen(true);
  }, [status?.type]);

  if (terminal) {
    return (
      <ToolCall
        label={action.label}
        activeLabel={action.activeLabel}
        query={queryOf(toolName, argsText)}
        request={requestTextOf(argsText)}
        result={resultTextOf(result, status, isError)}
        running={!terminal.done}
        success={terminal.success}
        open={open}
        onOpenChange={setOpen}
        content={<TerminalBlock {...terminal} className="mt-2 max-w-full" />}
      />
    );
  }

  return (
    <ToolCall
      label={action.label}
      activeLabel={action.activeLabel}
      query={queryOf(toolName, argsText)}
      request={requestTextOf(argsText)}
      result={resultTextOf(result, status, isError)}
      running={running}
      success={success}
      open={open}
      onOpenChange={setOpen}
    />
  );
};

AssistantToolCall.displayName = "AssistantToolCall";
