import type { ReactNode } from "react";

import { UserMessageActions } from "@/components/assistant-ui/user-message-actions";

export function UserMessageSurface({
  text,
  media,
  body,
  createdAt,
  kind = "user",
  pending = false,
}: {
  text: string;
  media?: ReactNode;
  body?: ReactNode;
  createdAt?: number;
  kind?: "user" | "steering";
  pending?: boolean;
}) {
  return (
    <div
      data-slot="aui_user-message-surface"
      data-role={kind}
      data-pending-steering={pending || undefined}
      data-time-hover-root
      className="group/user-message fade-in slide-in-from-bottom-1 animate-in flex w-full flex-col items-end gap-1.5 px-2 mt-3 duration-150"
    >
      <div className="flex min-w-0 max-w-[min(525px,82%)] flex-col items-end gap-2">
        {media}
        {body !== undefined ? (
          <div
            data-slot="aui_user-message-content"
            className="aui-user-message-content bg-muted text-foreground rounded-[22px] px-4 py-2 wrap-break-word empty:hidden"
          >
            {body}
          </div>
        ) : text !== "" ? (
          <div
            data-slot="aui_user-message-content"
            className="aui-user-message-content bg-muted text-foreground rounded-[22px] px-4 py-2 text-base leading-6 wrap-break-word whitespace-pre-wrap"
          >
            {text}
          </div>
        ) : null}
      </div>
      <UserMessageActions text={text} createdAt={createdAt} />
    </div>
  );
}
