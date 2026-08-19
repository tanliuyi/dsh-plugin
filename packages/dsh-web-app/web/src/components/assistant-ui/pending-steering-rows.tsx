import {
  SteeringImageList,
  type SteeringImage,
} from "@/components/assistant-ui/steering-image-list";
import { UserMessageSurface } from "@/components/assistant-ui/user-message-surface";
import { useDsh } from "@/dsh/store";

export function PendingSteeringRows() {
  const currentSessionId = useDsh((state) => state.currentSessionId);
  const queueSessionId = useDsh((state) => state.queueSessionId);
  const queueItems = useDsh((state) => state.queueItems);
  const messages = useDsh((state) => state.messages);

  if (currentSessionId === null || queueSessionId !== currentSessionId) {
    return null;
  }

  const pending = queueItems.filter(
    (item) =>
      item.placement === "steering" &&
      (item.messageId === undefined ||
        !messages.some((message) => message.id === item.messageId)),
  );
  if (pending.length === 0) return null;

  return (
    <>
      {pending.map((item) => (
        <UserMessageSurface
          key={`pending-steering-${item.id}`}
          text={item.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("")}
          media={
            <SteeringImageList
              images={item.parts.filter(
                (part): part is SteeringImage => part.type === "image",
              )}
            />
          }
          kind="steering"
          pending
        />
      ))}
    </>
  );
}
