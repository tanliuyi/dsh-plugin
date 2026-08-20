"use client";

import { Children, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, XCircleIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, field, mono } from "./surfaces";

/** Animated active/inactive label content used by the tool element. */
function ShimmerLabel({
  active,
  className,
  children,
  ...props
}: ComponentProps<"span"> & { active: boolean }) {
  return (
    <span {...props} className={cn("relative inline-block", className)}>
      <span>{children}</span>
      {active && (
        <span
          aria-hidden="true"
          className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** Crossfades the active and settled label supplied as children. */
function SwapLabel({
  active,
  className,
  children,
  ...props
}: ComponentProps<"span"> & { active: number; children: ReactNode }) {
  const labels = Children.toArray(children);
  return (
    <span
      {...props}
      className={cn("relative inline-grid min-w-0", className)}
    >
      {labels.map((label, index) => (
        <span
          key={index}
          aria-hidden={index !== active}
          className={cn(
            "col-start-1 row-start-1 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            index === active
              ? "relative opacity-100"
              : "pointer-events-none absolute inset-0 translate-y-0.5 opacity-0",
          )}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * The assistant-ui Elements tool-call surface. It is intentionally a
 * presentation component: the assistant-ui adapter supplies the tool state
 * and controls the disclosure.
 */
export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  /** Optional non-shrinking suffix for summaries such as parallel todo counts. */
  querySuffix?: ReactNode;
  request: string;
  result: string;
  /** Optional rich body for the standard Result field. */
  resultContent?: ReactNode;
  /** Optional custom content for tool-specific renderers such as TerminalBlock. */
  content?: ReactNode;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  /** Optional status override for adapters that can report tool failures. */
  success?: boolean;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  querySuffix,
  request,
  result,
  resultContent,
  content,
  running,
  open,
  onOpenChange,
  className,
  success = true,
}: ToolCallProps) {
  return (
    <Collapsible
      data-slot="tool-call"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger className="group/trigger max-w-full text-foreground/55 hover:text-foreground/90 flex items-center gap-2 rounded-md py-1 text-[13.5px] transition-colors outline-none">
        <SwapLabel active={running ? 0 : 1} className="text-start flex-shrink-0">
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/70 min-w-0 truncate rounded-md px-1.5 py-0.5",
          )}
          title={query}
        >
          {query}
        </span>
        {querySuffix !== undefined && querySuffix !== null && (
          <span className="shrink-0 text-xs tabular-nums text-foreground/50">
            {querySuffix}
          </span>
        )}
        <span className="ms-auto flex w-4 shrink-0 items-center justify-end">
          {!running &&
            (success ? (
              <CheckIcon className="fade-in zoom-in-90 animate-in size-3.5 text-emerald-500 duration-200" />
            ) : (
              <XCircleIcon className="fade-in zoom-in-90 animate-in size-3.5 text-destructive duration-200" />
            ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {content ?? (
          <div className={cn(field, "mt-2 overflow-hidden rounded-2xl text-xs")}>
            <div className="px-3.5 pt-2.5 pb-2">
              <p className={cn(mono, "text-foreground/35 mb-1")}>Request</p>
              <p className="text-foreground/55 max-h-48 overflow-auto font-mono break-words whitespace-pre-wrap">
                {request}
              </p>
            </div>
            <div className="bg-foreground/[0.06] mx-3.5 h-px" />
            <div className="px-3.5 pt-2 pb-2.5">
              <p className={cn(mono, "text-foreground/35 mb-1")}>Result</p>
              <div className="text-foreground/90 max-h-48 overflow-auto break-words whitespace-pre-wrap">
                {resultContent ?? result}
              </div>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
