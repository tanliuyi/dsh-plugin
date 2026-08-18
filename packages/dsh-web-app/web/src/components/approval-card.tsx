"use client";

import { useState, type ComponentProps } from "react";
import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ApprovalState = "request" | "running" | "done" | "denied";

type ApprovalAction = () => void | Promise<void>;

export function ApprovalCard({
  state,
  command,
  title,
  subtitle,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  state: ApprovalState;
  command?: string;
  title?: string;
  subtitle?: string;
  onAllowOnce?: ApprovalAction;
  onAlwaysAllow?: ApprovalAction;
  onDeny?: ApprovalAction;
}) {
  const [answered, setAnswered] = useState(false);
  const pending = state === "request" && !answered;
  const headline = subtitle || "此操作需要你的审批";

  const answer = (action?: ApprovalAction) => {
    if (!action || answered) return;
    setAnswered(true);
    try {
      const result = action();
      if (result instanceof Promise) {
        void result.catch(() => setAnswered(false));
      }
    } catch {
      setAnswered(false);
    }
  };

  return (
    <div
      data-slot="approval-card"
      className={cn(
        "border-warning bg-background flex w-full max-w-none flex-col overflow-hidden rounded-[20px] border",
        className,
      )}
      {...props}
    >
      <div className="bg-warning/10 text-warning-foreground flex min-h-9 items-center gap-2 px-4 py-2 text-sm">
        <span className="bg-warning size-2 shrink-0 rounded-full" aria-hidden="true" />
        <span className="font-medium">{state === "request" ? "等待审批" : title ?? "审批"}</span>
      </div>

      <div
        data-approval-scroll
        role="group"
        tabIndex={0}
        className="max-h-[min(40vh,16rem)] overflow-y-auto px-4 py-3 outline-none"
      >
        <p className="text-foreground text-[15px] leading-6">{headline}</p>
        {command ? (
          <div className="text-muted-foreground mt-1 flex min-w-0 items-start gap-2 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap">
            <TerminalIcon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
            <code className="min-w-0">{command}</code>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-14 items-center justify-end gap-2 px-4 pb-3">
        {state === "request" ? (
          <>
            <button
              type="button"
              disabled={!pending}
              onClick={() => answer(onDeny)}
              className="border-border bg-background text-foreground hover:bg-muted inline-flex h-9 items-center justify-center rounded-full border px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
            >
              拒绝
            </button>
            {onAlwaysAllow ? (
              <button
                type="button"
                disabled={!pending}
                onClick={() => answer(onAlwaysAllow)}
                className="border-border bg-background text-foreground hover:bg-muted inline-flex h-9 items-center justify-center rounded-full border px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
              >
                始终允许
              </button>
            ) : null}
            <button
              type="button"
              disabled={!pending}
              onClick={() => answer(onAllowOnce)}
              className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
            >
              允许一次
            </button>
          </>
        ) : (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            {state === "running" ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {state === "denied" ? <XIcon className="size-4" /> : null}
            {state === "done" ? <CheckIcon className="size-4 text-emerald-600" /> : null}
            {state === "running" ? "已允许，执行中" : state === "denied" ? "已拒绝" : "已完成"}
          </div>
        )}
      </div>
    </div>
  );
}
