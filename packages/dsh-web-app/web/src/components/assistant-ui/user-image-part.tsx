import type { ImageMessagePartComponent } from "@assistant-ui/react";

import { Image } from "@/components/assistant-ui/image";

export const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);
