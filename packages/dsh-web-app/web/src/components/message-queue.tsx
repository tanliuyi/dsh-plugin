"use client";

import type { ComponentProps } from "react";
import { ArrowUpIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, mono } from "@/lib/surfaces";

export interface QueuedMessage {
  id: string;
  text: string;
  placement?: "queued" | "steering" | "context";
}

export function MessageQueue({
  queued,
  onCancel,
  onSteer,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "queued" | "onCancel" | "onSteer"
> & {
  queued: readonly QueuedMessage[];
  onCancel?: (id: string) => void;
  onSteer?: (id: string) => void;
}) {
  if (queued.length === 0) return null;
  return (
    <div
      data-slot="message-queue"
      className={cn(
        "flex w-full max-w-none flex-col gap-2",
        "animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both",
        className,
      )}

      {...props}
    >
      {queued.length > 0 && (
        <div className="flex items-baseline justify-between px-1">
          <span className={cn(mono, "text-foreground/35")}>
            {queued.length} queued
          </span>
          <span className={cn(mono, "text-foreground/35")}>
            sends when this finishes
          </span>
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {queued.map((message, index) => (
          <li
            key={message.id}
            className={cn(
              field,
              "fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex items-center gap-2.5 rounded-2xl py-2 pr-2 pl-3 duration-300",
            )}
          >
            <span
              className={cn(
                mono,
                "text-foreground/30 w-3 shrink-0 tabular-nums",
              )}
            >
              {index + 1}
            </span>
            <span className="text-foreground/60 min-w-0 flex-1 truncate text-[13.5px]">
              {message.text}
            </span>
            <ArrowUpIcon className="text-foreground/25 size-3 shrink-0" />
            {message.placement === "queued" && (
              <button
                type="button"
                aria-label={`Send "${message.text}" next`}
                onClick={() => onSteer?.(message.id)}
                className={cn(ghostButton, "size-6 shrink-0")}
              >
                <ArrowUpIcon className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove "${message.text}" from the queue`}
              onClick={() => onCancel?.(message.id)}
              className={cn(ghostButton, "size-6 shrink-0")}
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
