import { MessagePrimitive, useAuiState } from "@assistant-ui/react";

import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import {
  SteeringImageList,
  type SteeringImage,
} from "@/components/assistant-ui/steering-image-list";
import { UserFilePart } from "@/components/assistant-ui/user-file-part";
import { UserMessageImages } from "@/components/assistant-ui/user-message-images";
import { UserMessageSurface } from "@/components/assistant-ui/user-message-surface";
import type { DshMessage, DshMessagePart } from "@/dsh/messages";

function epochTimeOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : undefined;
}

export function UserMessage({ steering }: { steering?: DshMessage }) {
  const content = useAuiState((state) => state.message.content);
  const createdAt = useAuiState((state) => state.message.createdAt);

  if (steering) {
    const text = steering.parts
      .filter(
        (part): part is Extract<DshMessagePart, { type: "steering" }> =>
          part.type === "steering",
      )
      .map((part) => part.text)
      .join("");
    const images = steering.parts.filter(
      (part): part is SteeringImage => part.type === "image",
    );
    return (
      <MessagePrimitive.Root
        data-slot="aui_user-message-root"
        data-role="steering"
        className="fade-in slide-in-from-bottom-1 animate-in w-full duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
      >
        <UserMessageSurface
          text={text}
          media={<SteeringImageList images={images} />}
          createdAt={steering.createdAt}
          kind="steering"
        />
      </MessagePrimitive.Root>
    );
  }

  const text = content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in w-full duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <UserMessageSurface
        text={text}
        media={
          <>
            <UserMessageImages />
            <UserMessageAttachments />
          </>
        }
        body={
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: () => null }}
          />
        }
        createdAt={epochTimeOf(createdAt)}
      />
    </MessagePrimitive.Root>
  );
}
