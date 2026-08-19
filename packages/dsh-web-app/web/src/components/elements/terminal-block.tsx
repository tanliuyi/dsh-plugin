"use client";

import type { ComponentProps } from "react";
import { CheckIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { mono, paper } from "./surfaces";
import { take } from "./range";

/**
 * assistant-ui Elements terminal surface for command execution output.
 * The optional exit information keeps the upstream shape while allowing the
 * host adapter to represent failed shell commands without showing exit 0.
 */
export function TerminalBlock({
  command,
  lines,
  visibleCount,
  done,
  success = true,
  exitCode,
  variant = "paper",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "command" | "lines" | "visibleCount" | "done" | "success" | "exitCode" | "variant"
> & {
  command: string;
  lines: readonly string[];
  visibleCount: number;
  done: boolean;
  success?: boolean;
  exitCode?: number | null;
  variant?: "paper" | "ink";
}) {
  const ink = variant === "ink";
  const visibleLines = take(lines, visibleCount);
  const statusLabel = success
    ? `exit ${exitCode ?? 0}`
    : exitCode === undefined || exitCode === null
      ? "failed"
      : `exit ${exitCode}`;

  return (
    <div
      data-slot="terminal-block"
      role="status"
      className={cn(
        ink ? "bg-foreground dark:bg-popover" : paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-3 pb-1.5">
        <span
          title={command}
          className={cn(
            "min-w-0 flex-1 line-clamp-2 break-words",
            ink
              ? "text-background/90 dark:text-foreground/90"
              : "text-foreground/90",
          )}
        >
          {command}
        </span>
        {done ? (
          <div className="flex shrink-0 items-center gap-1">
            {success ? (
              <CheckIcon className="size-3 text-emerald-500" aria-hidden="true" />
            ) : (
              <XCircleIcon className="text-destructive size-3" aria-hidden="true" />
            )}
            <span
              className={cn(
                mono,
                success
                  ? ink
                    ? "text-background/40 dark:text-foreground/40"
                    : "text-foreground/40"
                  : "text-destructive",
              )}
            >
              {statusLabel}
            </span>
          </div>
        ) : (
          <Loader2Icon
            className={cn(
              "size-3 shrink-0 animate-spin motion-reduce:animate-none",
              ink
                ? "text-background/35 dark:text-foreground/35"
                : "text-foreground/35",
            )}
            aria-label="Running"
          />
        )}
      </div>
      <div
        className={cn(
          "flex min-h-[8.5rem] max-h-64 flex-col gap-1 overflow-auto px-4 pt-1 pb-3.5",
          ink
            ? "text-background/55 dark:text-foreground/50"
            : "text-foreground/50",
        )}
      >
        {visibleLines.map((line, i) => {
          const isLast = i === visibleLines.length - 1;
          return (
            <div
              key={`${i}-${line}`}
              className={cn(
                "fade-in animate-in fill-mode-both whitespace-pre-wrap break-words duration-300",
                isLast &&
                  (ink
                    ? "text-background/90 dark:text-foreground/90"
                    : "text-foreground/90"),
              )}
            >
              {line}
            </div>
          );
        })}
        {!done && (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-1.5 animate-pulse bg-blue-500/70 motion-reduce:animate-none dark:bg-blue-400/70"
          />
        )}
      </div>
    </div>
  );
}
