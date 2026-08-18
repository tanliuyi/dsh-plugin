"use client";

import type { ComponentProps } from "react";
import { CheckIcon, PencilIcon, PlugIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { field, inkButton, mono, paper } from "@/lib/surfaces";

export type ElicitationState = "request" | "accepted" | "declined";

export interface ElicitationOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ElicitationField {
  name: string;
  label: string;
  value: string;
  customValue?: string;
  selected?: readonly string[];
  kind: "text" | "choice" | "toggle";
  options?: readonly ElicitationOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  customPlaceholder?: string;
  required?: boolean;
}

export function ElicitationForm({
  server,
  message,
  fields,
  state,
  onAccept,
  onDecline,
  onFieldChange,
  onCustomChange,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "server"
  | "message"
  | "fields"
  | "state"
  | "onAccept"
  | "onDecline"
  | "onFieldChange"
> & {
  server: string;
  message: string;
  fields: readonly ElicitationField[];
  state: ElicitationState;
  onAccept?: () => void;
  onDecline?: () => void;
  onFieldChange?: (name: string, value: string) => void;
  onCustomChange?: (name: string, value: string) => void;
}) {
  return (
    <div
      data-slot="elicitation-form"
      className={cn(
        paper,
        "flex w-full flex-col gap-3.5 rounded-[20px] p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-7 shrink-0 items-center justify-center rounded-lg">
          <PlugIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
          {server}
        </span>
        <span className={cn(mono, "text-foreground/30 shrink-0")}>
          needs input
        </span>
      </div>

      <p className="text-foreground/55 text-xs leading-relaxed">{message}</p>

      <div className="flex flex-col gap-2.5">
        {fields.map((item) => (
          <div key={item.name} className="flex flex-col gap-1">
            <span className={cn(mono, "text-foreground/35")}>
              {item.label}
              {item.required && <span className="text-foreground/25"> *</span>}
            </span>
            {item.kind === "choice" ? (
              <div className="flex flex-wrap gap-1.5">
                {item.options?.map((option, optionIndex) => (
                  <button
                    key={`${option.value}-${optionIndex}`}
                    type="button"
                    onClick={() => onFieldChange?.(item.name, option.value)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors",
                      item.selected?.includes(option.value)
                        ? "bg-foreground text-background"
                        : cn(field, "text-foreground/55"),
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span>{option.label}</span>
                        {option.recommended ? (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                            推荐
                          </span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[11px] opacity-70">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {item.multiSelect ? (
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                          item.selected?.includes(option.value)
                            ? "border-current"
                            : "border-current/30",
                        )}
                      >
                        {item.selected?.includes(option.value) ? <CheckIcon className="size-3" /> : null}
                      </span>
                    ) : null}
                  </button>
                ))}
                {item.allowCustom ? (
                  <div className={cn(field, "flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2", item.customValue && "ring-1 ring-ring")}>
                    <PencilIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <Input
                      value={item.customValue ?? ""}
                      onChange={(event) => onCustomChange?.(item.name, event.target.value)}
                      placeholder={item.customPlaceholder ?? "Custom answer"}
                      className="h-6 w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
                    />
                  </div>
                ) : null}
              </div>
            ) : item.kind === "toggle" ? (
              <button
                type="button"
                onClick={() => onFieldChange?.(item.name, item.value === "true" ? "false" : "true")}
                className="flex items-center gap-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-7 items-center rounded-full p-0.5 transition-colors duration-200",
                    item.value === "true"
                      ? "bg-foreground/80"
                      : "bg-foreground/15",
                  )}
                >
                  <span
                    className={cn(
                      "bg-background size-3 rounded-full transition-transform duration-200 motion-reduce:transition-none",
                      item.value === "true" && "translate-x-3",
                    )}
                  />
                </span>
                <span className="text-foreground/55 text-xs">
                  {item.value === "true" ? "On" : "Off"}
                </span>
              </button>
            ) : (
              <Input
                value={item.customValue ?? item.value}
                onChange={(event) => onCustomChange?.(item.name, event.target.value)}
                className={cn(
                  field,
                  "text-foreground/80 rounded-lg px-2.5 py-1.5 text-xs outline-none",
                )}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex h-8 items-center justify-end gap-2">
        {state === "request" ? (
          <>
            <button
              type="button"
              onClick={onDecline}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={onAccept}
              className={cn(
                inkButton,
                "flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
              )}
            >
              Send
            </button>
          </>
        ) : (
          <span
            key={state}
            className="fade-in animate-in text-foreground/55 flex items-center gap-2 text-xs duration-300"
          >
            {state === "accepted" ? (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                Sent to {server}
              </>
            ) : (
              <>
                <XIcon className="text-foreground/45 size-3.5" />
                Declined
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
