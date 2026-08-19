import { useAuiState } from "@assistant-ui/react";

import { PendingSteeringRows } from "@/components/assistant-ui/pending-steering-rows";

export function PendingSteeringBeforeLoader() {
  const messageId = useAuiState((state) => state.message.id);
  const lastMessageId = useAuiState(
    (state) => state.thread.messages.at(-1)?.id,
  );
  if (messageId !== lastMessageId) return null;
  return <PendingSteeringRows />;
}
