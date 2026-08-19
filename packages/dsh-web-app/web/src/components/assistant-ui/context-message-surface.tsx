import { useState } from "react";
import { PaperclipIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { collapsePanel, field, mono } from "@/components/elements/surfaces";
import type { DshMessagePart } from "@/dsh/messages";
import { cn } from "@/lib/utils";

type ContextMessagePart = Extract<DshMessagePart, { type: "context" }>;

export function ContextMessageSurface({
  context,
}: {
  context: ContextMessagePart;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible
      data-slot="aui_context-message"
      open={expanded}
      onOpenChange={setExpanded}
      className="fade-in animate-in w-full py-0.5 duration-150"
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md py-1 text-[13.5px] transition-colors outline-none">
        <PaperclipIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 opacity-55"
        />
        <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/70 min-w-0 max-w-[45%] shrink-0 truncate rounded-md px-1.5 py-0.5 text-xs",
          )}
          title={context.label}
        >
          {context.label || "context"}
        </span>
        <span className="text-foreground/45 min-w-0 flex-1 truncate text-start text-[13px]">
          {context.text}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div
          className={cn(
            field,
            "mt-2 max-h-72 overflow-auto rounded-xl px-3.5 py-2.5 text-xs",
          )}
        >
          <p
            className={cn(
              mono,
              "text-foreground/55 leading-5 whitespace-pre-wrap wrap-break-word",
            )}
          >
            {context.text}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
