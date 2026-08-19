import { LoaderCircleIcon } from "lucide-react";

export function ThreadLoading() {
  return (
    <div
      data-slot="aui_thread-loading"
      className="text-muted-foreground flex h-full min-h-0 w-full flex-1 items-center justify-center gap-2 text-sm"
      role="status"
    >
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
      <span>Loading conversation...</span>
    </div>
  );
}
