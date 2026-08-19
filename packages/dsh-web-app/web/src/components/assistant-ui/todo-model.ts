/** Pure dsh todo presentation models shared by the panel, row, and tests. */

import type { TodoItem } from "../../dsh/api";

export interface TodoListModelItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done";
}

export interface TodoLike {
  content?: unknown;
  status?: unknown;
}

export interface TodoSummary {
  done: number;
  total: number;
  activeContent: string | null;
  activeExtra: number;
}

/** Upstream header summary: omit zero-count statuses and count parallel work. */
export function progressLabel(todos: readonly TodoItem[]): string {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.filter((item) => item.status === "in_progress").length;
  const pending = todos.length - done - active;
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待处理`] : []),
  ].join("\u2002·\u2002");
}

/** Adapt the dsh wire vocabulary to the assistant-ui element vocabulary. */
export function todoListItemsOf(
  todos: readonly TodoItem[],
): TodoListModelItem[] {
  return todos.map((item, index) => ({
    id: `${index}:${item.content}`,
    text: item.content,
    status:
      item.status === "completed"
        ? "done"
        : item.status === "in_progress"
          ? "active"
          : "pending",
  }));
}

/** Mirrors the upstream plan-summary split so +N survives narrow-row ellipsis. */
export function todoSummaryOf(todos: readonly TodoLike[]): TodoSummary {
  const active = todos.filter((item) => item.status === "in_progress");
  const first = active[0]?.content;
  const activeContent =
    typeof first === "string" && first.trim() !== "" ? first : null;
  return {
    done: todos.filter((item) => item.status === "completed").length,
    total: todos.length,
    activeContent,
    activeExtra: activeContent === null ? 0 : active.length - 1,
  };
}
