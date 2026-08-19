import { useContext } from "react";
import { useAuiState } from "@assistant-ui/react";

import { AssistantMessage } from "@/components/assistant-ui/assistant-message";
import { CompactionMessage } from "@/components/assistant-ui/compaction-message";
import { ContextMessageSurface } from "@/components/assistant-ui/context-message-surface";
import { EditComposer } from "@/components/assistant-ui/edit-composer";
import { ThreadComponentsContext } from "@/components/assistant-ui/thread-components-context";
import {
  isCompactionOnlyContent,
  isContextOnlyContent,
} from "@/components/assistant-ui/thread-message-model";
import { UserMessage } from "@/components/assistant-ui/user-message";
import { useDsh } from "@/dsh/store";

export function ThreadMessage() {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const messageId = useAuiState((state) => state.message.id);
  const role = useAuiState((state) => state.message.role);
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  const isContextOnly = useAuiState((state) =>
    isContextOnlyContent(state.message.content),
  );
  const isCompactionOnly = useAuiState((state) =>
    isCompactionOnlyContent(state.message.content),
  );
  const sourceMessage = useDsh((state) =>
    messageId
      ? state.messages.find((message) => message.id === messageId)
      : undefined,
  );
  const steering = sourceMessage?.role === "steering" ? sourceMessage : undefined;
  const context =
    isContextOnly &&
    sourceMessage?.parts.length === 1 &&
    sourceMessage.parts[0]?.type === "context"
      ? sourceMessage.parts[0]
      : undefined;
  const compaction =
    isCompactionOnly &&
    sourceMessage?.parts.length === 1 &&
    sourceMessage.parts[0]?.type === "compaction"
      ? sourceMessage.parts[0]
      : undefined;

  if (isEditing) return <EditComposer />;
  if (steering) return <UserMessage steering={steering} />;
  if (context) return <ContextMessageSurface context={context} />;
  if (compaction) return <CompactionMessage compaction={compaction} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
}
