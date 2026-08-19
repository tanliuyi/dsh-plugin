"use client";

import { useEffect, useState } from "react";
import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { ToolCall } from "@/components/elements/tool-call";
import { AssistantToolCall } from "@/components/assistant-ui/tool-call";
import { todoSummaryOf, type TodoLike, type TodoSummary } from "./todo-model";

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

function resultTextOf(
  result: unknown,
  status: ToolCallMessagePartStatus | undefined,
  isError: boolean | undefined,
): string {
  if (result !== undefined) return stringifyToolValue(result);
  if (status?.type === "running") return "等待结果…";
  if (isError || status?.type === "incomplete") return "工具执行失败";
  return "无结果";
}

function todoSummaryFromArgs(argsText: string | undefined): TodoSummary | null {
  if (!argsText) return null;
  const parsed = parseJsonLayers(argsText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const todos = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(todos) || !todos.every((item) => typeof item === "object" && item !== null)) {
    return null;
  }
  return todoSummaryOf(todos as TodoLike[]);
}

/** Product todo_write row: counts, first active item, and a safe +N suffix. */
export const AssistantTodoToolCall: ToolCallMessagePartComponent = (props) => {
  const { argsText, result, status, isError } = props;
  const [open, setOpen] = useState(false);
  const running = status?.type === "running";
  const success = !isError && (status === undefined || status.type === "complete");
  const summary = todoSummaryFromArgs(argsText);

  useEffect(() => {
    if (status?.type === "requires-action") setOpen(true);
  }, [status?.type]);

  if (summary === null) return <AssistantToolCall {...props} />;

  const activeHint = summary.activeContent
    ? ` · ${summary.activeContent}`
    : "";
  return (
    <ToolCall
      label="更新"
      activeLabel="更新中"
      query={`${summary.done}/${summary.total} 已完成${activeHint}`}
      querySuffix={summary.activeExtra > 0 ? `+${summary.activeExtra}` : null}
      request={argsText ? stringifyToolValue(parseJsonLayers(argsText)) : "{}"}
      result={resultTextOf(result, status, isError)}
      running={running}
      success={success}
      open={open}
      onOpenChange={setOpen}
    />
  );
};

AssistantTodoToolCall.displayName = "AssistantTodoToolCall";
