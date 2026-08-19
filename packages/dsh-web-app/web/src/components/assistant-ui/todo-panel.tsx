"use client";

import { TodoList } from "@/components/elements/todo-list";
import { useDsh } from "@/dsh/store";
import { progressLabel, todoListItemsOf } from "./todo-model";

/**
 * The projection-backed plan strip. It lives directly above the composer, keeps
 * its collapsed state local, and follows the upstream lifetime: todo/write
 * replaces the whole list, turn/start clears it, and turn/end leaves it visible.
 */
export function TodoPanel() {
  const todos = useDsh((state) => state.todos);
  if (!todos || todos.length === 0) return null;

  return (
    <TodoList
      data-testid="todo-panel"
      role="region"
      aria-label="任务"
      items={todoListItemsOf(todos)}
      title="任务"
      summary={progressLabel(todos)}
      collapsible
      defaultCollapsed
      variant="dsh"
    />
  );
}
