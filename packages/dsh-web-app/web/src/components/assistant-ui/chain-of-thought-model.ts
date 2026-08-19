import type { PartState } from "@assistant-ui/react";
import type { PropsWithChildren } from "react";

export const CHAIN_OF_THOUGHT_ANIMATION_MS = 200;

export type ChainOfThoughtProps = PropsWithChildren<{
  /** Absolute message part indices covered by one chain-of-thought group. */
  indices: readonly number[];
}>;

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
  read: "读取一些文件",
  write: "修改一些文件",
  edit: "修改一些文件",
  glob: "查找一些文件",
  grep: "搜索一些内容",
  find: "查找一些文件",
  ls: "查看一些目录",
  pwsh: "执行一些命令",
  bash: "执行一些命令",
  web_search: "搜索网络",
  subagent: "调度子智能体",
  subagent_fork: "派生子智能体",
  subagent_wait: "等待子智能体",
  workflow: "编排多智能体",
  memory: "整理记忆",
  memory_add: "整理记忆",
  memory_replace: "整理记忆",
  memory_remove: "整理记忆",
  memory_search: "检索记忆",
  session_search: "检索历史会话",
  skill_manage: "整理技能",
  ask_user_question: "向你提问",
  contact_supervisor: "汇报上级",
  todo_write: "更新任务列表",
  read_image: "查看图片",
};

export function hasTextAfterIndex(
  parts: readonly PartState[],
  endIndex: number,
): boolean {
  for (let index = endIndex + 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part?.type === "text" && (part.text?.trim().length ?? 0) > 0) return true;
  }
  return false;
}

export function summarizeChainOfThoughtRange(
  parts: readonly PartState[],
  startIndex: number,
  endIndex: number,
): string {
  const summaries = new Set<string>();
  let hasUnknownTool = false;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const part = parts[index];
    if (part?.type !== "tool-call") continue;
    const summary = TOOL_SUMMARIES[part.toolName];
    if (summary) summaries.add(summary);
    else hasUnknownTool = true;
  }

  if (hasUnknownTool) summaries.add("使用其他工具");
  const values = [...summaries];
  if (values.length === 0) return "思考";
  if (values.length <= 3) return values.join("，");
  return `${values.slice(0, 3).join("，")}等操作`;
}

/** Compatibility helpers retained for existing callers and tests. */
export function hasTextAfterGroup(
  parts: readonly PartState[],
  indices: readonly number[],
): boolean {
  const endIndex = indices.at(-1);
  return endIndex === undefined ? false : hasTextAfterIndex(parts, endIndex);
}

export function summarizeChainOfThought(
  parts: readonly PartState[],
  indices: readonly number[],
): string {
  const startIndex = indices[0];
  const endIndex = indices.at(-1);
  return startIndex === undefined || endIndex === undefined
    ? "思考"
    : summarizeChainOfThoughtRange(parts, startIndex, endIndex);
}
