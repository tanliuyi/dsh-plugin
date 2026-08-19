import type { FileMessagePartComponent } from "@assistant-ui/react";

import { File } from "@/components/assistant-ui/file";

export const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);
