import { useCallback, useEffect, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

const USER_MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function formatUserMessageTime(time?: number): string | undefined {
  return time === undefined
    ? undefined
    : USER_MESSAGE_TIME_FORMATTER.format(new Date(time));
}

export function UserMessageActions({
  text,
  createdAt,
}: {
  text: string;
  createdAt?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const hideActions = useAuiState(
    (state) =>
      state.thread.isRunning ||
      (!state.message.isLast && !state.message.isHovering),
  );
  const timestamp = hideActions ? undefined : formatUserMessageTime(createdAt);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const copy = useCallback(async () => {
    if (text === "" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopied(false);
    }, 1_000);
  }, [text]);

  if (createdAt === undefined && text === "") return null;

  return (
    <div
      data-slot="aui_user-message-actions"
      aria-hidden={hideActions || undefined}
      className={cn(
        "flex h-7 items-center gap-2 text-muted-foreground",
        hideActions && "invisible pointer-events-none",
      )}
    >
      {!hideActions && (
        <>
          {timestamp !== undefined && (
            <span className="text-sm leading-6 opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100">
              {timestamp}
            </span>
          )}
          {text !== "" && (
            <TooltipIconButton
              tooltip={copied ? "Copied" : "Copy"}
              aria-label={copied ? "Copied" : "Copy"}
              onClick={() => void copy()}
              className="size-7"
            >
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </TooltipIconButton>
          )}
        </>
      )}
    </div>
  );
}
