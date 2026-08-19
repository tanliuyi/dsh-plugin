"use client";

import { useState } from "react";
import { ChevronRightIcon, SquareTerminalIcon } from "lucide-react";

import { MarkdownStatic } from "@/components/assistant-ui/markdown-static";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { DshMessagePart } from "@/dsh/messages";
import { cn } from "@/lib/utils";

type CompactionPart = Extract<DshMessagePart, { type: "compaction" }>;

function compactionSummary(
  compaction: CompactionPart,
  fallbackSummary?: string | null,
): string {
  if (
    compaction.shadowedItemCount !== null &&
    compaction.shadowedTokenCount !== null
  ) {
    return `已压缩 ${compaction.shadowedItemCount} 条历史记录（约 ${compaction.shadowedTokenCount} tokens）`;
  }
  if (fallbackSummary) return fallbackSummary.replace(/\.$/, "");
  return compaction.summary === null ? "压缩摘要不可用" : "查看压缩摘要";
}

export function CompactionMessage({
  compaction,
  title = "上下文已压缩",
  fallbackSummary,
}: {
  compaction: CompactionPart;
  title?: string;
  fallbackSummary?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const expandable = compaction.summary !== null;

  return (
    <Collapsible
      data-slot="aui_compaction"
      open={open && expandable}
      onOpenChange={setOpen}
      className="fade-in animate-in w-full py-0.5 duration-150"
    >
      <CollapsibleTrigger
        disabled={!expandable}
        className="group/compaction text-foreground/75 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none transition-colors enabled:hover:text-foreground disabled:cursor-default"
      >
        <SquareTerminalIcon
          aria-hidden="true"
          className="size-4 shrink-0 stroke-[1.75]"
        />
        <span className="shrink-0 text-[13.5px] font-medium">{title}</span>
        <span aria-hidden="true" className="text-foreground/25">·</span>
        <span
          className="text-muted-foreground min-w-0 truncate text-[13px]"
          title={compactionSummary(compaction, fallbackSummary)}
        >
          {compactionSummary(compaction, fallbackSummary)}
        </span>
        {expandable && (
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </CollapsibleTrigger>
      {expandable && (
        <CollapsibleContent className="overflow-hidden pl-6 outline-none">
          <div className="border-border/60 mt-1 border-l pl-3 pb-2">
            <MarkdownStatic
              text={compaction.summary ?? ""}
              className="text-foreground/75 text-[13px] leading-relaxed"
            />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
