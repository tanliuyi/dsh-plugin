import { useEffect, useRef, type PropsWithChildren } from "react";

import { ReasoningFade } from "@/components/assistant-ui/reasoning";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { followResizingContentToBottom } from "@/lib/follow-resizing-content-to-bottom";
import { cn } from "@/lib/utils";

export function ChainOfThoughtContent({
  open,
  preview,
  children,
}: PropsWithChildren<{ open: boolean; preview: boolean }>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview) return;
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;
    return followResizingContentToBottom(scrollElement, contentElement, {
      respectUserScroll: true,
    });
  }, [preview]);

  return (
    <Collapsible open={open}>
      <CollapsibleContent
        data-slot="aui_chain-of-thought-content"
        className={cn(
          "aui-chain-of-thought-content relative overflow-hidden outline-none",
          "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
          "data-open:duration-(--animation-duration) data-closed:duration-(--animation-duration)",
        )}
      >
        <ReasoningFade side="top" />
        <div
          ref={scrollRef}
          data-slot="aui_chain-of-thought-scroll"
          className={cn(
            "border-border/50 relative z-0 max-h-[40vh] overflow-y-auto border-t pt-1.5 pb-2",
            "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
            "group-data-open/collapsible-content:animate-in group-data-closed/collapsible-content:animate-out",
            "group-data-open/collapsible-content:fade-in-0 group-data-closed/collapsible-content:fade-out-0",
            "group-data-open/collapsible-content:slide-in-from-top-4 group-data-closed/collapsible-content:slide-out-to-top-4",
            "group-data-open/collapsible-content:blur-in-[2px] group-data-closed/collapsible-content:blur-out-[2px]",
            "group-data-open/collapsible-content:duration-(--animation-duration) group-data-closed/collapsible-content:duration-(--animation-duration)",
          )}
        >
          <div ref={contentRef} className="flex flex-col gap-1">
            {children}
          </div>
        </div>
        {preview ? <ReasoningFade /> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
