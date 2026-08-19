import { ChainOfThoughtPrimitive } from "@assistant-ui/react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function ChainOfThoughtTrigger({
  label,
  running,
  open,
  onEngage,
}: {
  label: string;
  running: boolean;
  open: boolean;
  onEngage: () => void;
}) {
  return (
    <ChainOfThoughtPrimitive.AccordionTrigger
      data-slot="aui_chain-of-thought-trigger"
      onClick={onEngage}
      className="aui-chain-of-thought-trigger group/trigger flex w-fit-content cursor-pointer items-center gap-1.5 py-1.5 text-start text-sm font-medium transition-[background-color,color,scale] active:scale-[0.98]"
      aria-busy={running}
    >
      <span
        data-slot="aui_chain-of-thought-trigger-label"
        className="aui-chain-of-thought-trigger-label-wrapper text-muted-foreground relative inline-block leading-tight"
      >
        <span className="line-clamp-1">{label}</span>
        {running ? (
          <span
            aria-hidden
            data-slot="aui_chain-of-thought-trigger-shimmer"
            className="aui-chain-of-thought-trigger-shimmer shimmer pointer-events-none absolute inset-0 line-clamp-1 motion-reduce:animate-none"
          >
            {label}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="aui_chain-of-thought-trigger-chevron"
        className={cn(
          "aui-chain-of-thought-trigger-chevron text-muted-foreground ms-auto size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          open ? "rotate-0" : "-rotate-90",
        )}
      />
    </ChainOfThoughtPrimitive.AccordionTrigger>
  );
}
