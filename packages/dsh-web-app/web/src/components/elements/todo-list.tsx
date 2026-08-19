"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ListTodoIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { mono } from "./surfaces";

/** Status vocabulary used by the assistant-ui TodoList element. */
export type TodoStatus = "pending" | "active" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export type TodoListVariant = "default" | "dsh";

export interface TodoListProps
  extends Omit<
    ComponentProps<"div">,
    "children" | "items" | "revision" | "title"
  > {
  /** The list as it stands right now. */
  items: readonly TodoItem[];
  /** Optional rewrite number shown by the stock assistant-ui header. */
  revision?: number;
  /** Override the stock "Todos" heading. */
  title?: ReactNode;
  /** Override the stock done/total summary. */
  summary?: ReactNode;
  /** Make the header a disclosure control. */
  collapsible?: boolean;
  /** Initial disclosure state when `collapsible` is enabled. */
  defaultCollapsed?: boolean;
  /** The dsh skin matches the upstream harness plan strip. */
  variant?: TodoListVariant;
}

function statusMark(status: TodoStatus, variant: TodoListVariant) {
  if (status === "active") {
    return (
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none dark:text-blue-400"
      />
    );
  }

  if (status === "done") {
    if (variant === "dsh") {
      return <CircleCheckIcon className="size-3.5 text-emerald-500" aria-hidden="true" />;
    }
    return (
      <span className="flex size-3.5 items-center justify-center rounded-[5px] border border-foreground/20 bg-foreground/[0.06] text-foreground/45">
        <CheckIcon className="size-2.5" aria-hidden="true" />
      </span>
    );
  }

  if (variant === "dsh") {
    return <CircleDashedIcon className="size-3.5 text-muted-foreground/60" aria-hidden="true" />;
  }

  return <span aria-hidden="true" className="size-3.5 rounded-[5px] border border-foreground/15" />;
}

function itemStatus(status: TodoStatus, variant: TodoListVariant): string {
  if (variant !== "dsh") return status;
  if (status === "done") return "completed";
  if (status === "active") return "in_progress";
  return "pending";
}

/**
 * Assistant-ui's TodoList element, with an optional dsh skin. The default
 * rendering follows the public element contract; the dsh skin adds the
 * collapsible, projection-backed plan strip used by the upstream product.
 */
export function TodoList({
  items,
  revision,
  title,
  summary,
  collapsible = false,
  defaultCollapsed = false,
  variant = "default",
  className,
  ...props
}: TodoListProps) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const done = items.filter((item) => item.status === "done").length;
  const headerTitle = title ?? (variant === "dsh" ? "任务" : "Todos");
  const headerSummary =
    summary ??
    (revision === undefined
      ? `${done}/${items.length}`
      : `${done}/${items.length} · rev ${revision}`);
  const showItems = !collapsible || !collapsed;

  const header = collapsible ? (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 text-start outline-none",
        variant === "dsh"
          ? "min-h-9 px-3 py-1.5 text-[13px]"
          : "justify-between text-[13.5px] font-medium",
      )}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed((value) => !value)}
    >
      {variant === "dsh" && (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ListTodoIcon className="size-3.5" />
        </span>
      )}
      <span className={cn(variant === "dsh" && "shrink-0 font-medium")}>
        {headerTitle}
      </span>
      <span
        className={cn(
          variant === "dsh"
            ? "min-w-0 flex-1 truncate text-muted-foreground"
            : cn(mono, "text-foreground/35 tabular-nums"),
        )}
      >
        {headerSummary}
      </span>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        {collapsed ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronUpIcon className="size-3.5" />
        )}
      </span>
    </button>
  ) : (
    <div className="flex items-baseline justify-between">
      <span className="text-[13.5px] font-medium">{headerTitle}</span>
      <span className={cn(mono, "text-foreground/35 tabular-nums")}>
        {headerSummary}
      </span>
    </div>
  );

  return (
    <div
      data-slot="todo-list"
      data-variant={variant}
      className={cn(
        variant === "dsh"
          ? "flex w-full max-w-[96%] mx-auto flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/30"
          : "flex w-full max-w-sm flex-col gap-3",
        className,
      )}
      {...props}
    >
      {variant === "dsh" ? (
        <div className="flex flex-col">
          {header}
          {showItems && (
            <ul className="flex max-h-44 flex-col gap-1.5 overflow-y-auto border-t border-border/50 px-3 py-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  data-status={itemStatus(item.status, variant)}
                  className="flex min-w-0 items-start gap-2.5 py-0.5 text-[13px] leading-5"
                >
                  <span className="flex size-4 h-5 shrink-0 items-center justify-center">
                    {statusMark(item.status, variant)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-muted-foreground",
                      item.status === "active" && "text-foreground/90",
                    )}
                    title={item.text}
                  >
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          {header}
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li
                key={item.id}
                data-status={itemStatus(item.status, variant)}
                className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex items-start gap-2.5 py-0.5 text-[13.5px] duration-300"
              >
                <span className="flex size-4 h-5 shrink-0 items-center justify-center">
                  {statusMark(item.status, variant)}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 leading-5 break-words",
                    item.status === "done" &&
                      "text-foreground/35 line-through decoration-[1.5px]",
                    item.status === "active" && "text-foreground/90",
                    item.status === "pending" && "text-foreground/50",
                  )}
                >
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
