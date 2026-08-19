import { useAuiState } from "@assistant-ui/react";

import { UserImagePart } from "@/components/assistant-ui/user-image-part";

export function UserMessageImages() {
  const content = useAuiState((state) => state.message.content);
  const images = content.filter((part) => part.type === "image");
  if (images.length === 0) return null;

  return (
    <div
      data-slot="aui_user-message-images"
      className="aui-user-message-images flex flex-wrap justify-end gap-2"
    >
      {images.map((part, index) => (
        <UserImagePart
          key={`${part.image}-${index}`}
          {...part}
          status={{ type: "complete" }}
        />
      ))}
    </div>
  );
}
