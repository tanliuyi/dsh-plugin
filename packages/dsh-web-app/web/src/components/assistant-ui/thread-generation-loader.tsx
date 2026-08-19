import type { ReactNode } from "react";

import { GenerationLoader } from "@/components/elements/loading-state";

export function ThreadGenerationLoader({ before }: { before?: ReactNode }) {
  return (
    <>
      {before}
      <GenerationLoader
        label="Generating"
        role="status"
        aria-label="Assistant is working"
        className="aui-assistant-message-indicator items-start mt-4"
      />
    </>
  );
}
