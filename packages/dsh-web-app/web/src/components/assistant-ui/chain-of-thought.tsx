"use client";

import {
  ChainOfThoughtByIndicesProvider,
  ChainOfThoughtPrimitive,
  useAuiState,
  type PartState,
} from "@assistant-ui/react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type MouseEvent,
  type PropsWithChildren,
} from "react";
import { cn } from "@/lib/utils";
import { followResizingContentToBottom } from "@/lib/follow-resizing-content-to-bottom";
import { ReasoningFade } from "@/components/assistant-ui/reasoning";

const ANIMATION_DURATION = 200;

export type ChainOfThoughtProps = PropsWithChildren<{
  /**
   * Absolute message part indices covered by the `group-chainOfThought`
   * group (a coalesced run of reasoning + tool-call parts). Used both to
   * scope the `chainOfThought` client and to summarize/locate the group.
   */
  indices: readonly number[];
}>;

/** 组结束索引之后是否还有非空 text part（最终答案正文）。 */
export function hasTextAfterGroup(
  parts: readonly PartState[],
  indices: readonly number[],
): boolean {
  const endIndex = indices.at(-1);
  if (endIndex === undefined) return false;
  for (let index = endIndex + 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part?.type === "text" && (part.text?.trim().length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
  read: "读取一些文件",
  write: "修改一些文件",
  edit: "修改一些文件",
  glob: "查找一些文件",
  grep: "搜索一些内容",
  find: "查找一些文件",
  ls: "查看一些目录",
  pwsh: "执行一些命令",
  bash: "执行一些命令",
  web_search: "搜索网络",
  subagent: "调度子智能体",
  subagent_fork: "派生子智能体",
  subagent_wait: "等待子智能体",
  workflow: "编排多智能体",
  memory: "整理记忆",
  memory_add: "整理记忆",
  memory_replace: "整理记忆",
  memory_remove: "整理记忆",
  memory_search: "检索记忆",
  session_search: "检索历史会话",
  skill_manage: "整理技能",
  ask_user_question: "向你提问",
  contact_supervisor: "汇报上级",
  todo_write: "更新任务列表",
  read_image: "查看图片",
};

/** 用组内的 tool-call 生成一句话动作摘要；纯推理无工具时回落 “思考”。 */
export function summarizeChainOfThought(
  parts: readonly PartState[],
  indices: readonly number[],
): string {
  const summaries = new Set<string>();
  let hasUnknownTool = false;

  for (const index of indices) {
    const part = parts[index];
    if (part?.type !== "tool-call") continue;
    const summary = TOOL_SUMMARIES[part.toolName];
    if (summary) summaries.add(summary);
    else hasUnknownTool = true;
  }

  if (hasUnknownTool) summaries.add("使用其他工具");
  const values = [...summaries];
  if (values.length === 0) return "思考";
  if (values.length <= 3) return values.join("，");
  return `${values.slice(0, 3).join("，")}等操作`;
}

/**
 * Chain of thought wrapper for a `group-chainOfThought` group produced by
 * `MessagePrimitive.GroupedParts`. It ties the nested reasoning and
 * tool-call accordions into a single collapsible "thinking" disclosure
 * built on the assistant-ui `ChainOfThoughtPrimitive`:
 *
 * - `ChainOfThoughtByIndicesProvider` scopes the `chainOfThought` client
 *   (collapsed state, group status) to the grouped part slice.
 * - `ChainOfThoughtPrimitive.Root` is the container and
 *   `ChainOfThoughtPrimitive.AccordionTrigger` is the toggle (its own
 *   `onClick` additionally marks a user engagement).
 *
 * Display logic (ported from meta-agent-v2's `ChainOfThoughtGroup`):
 * - The trigger label is a natural-language summary of the group's tool
 *   calls (`summarizeChainOfThought`), falling back to “思考”.
 * - The disclosure is held **open while streaming** (live preview).
 * - It also stays open after finishing when the group **ran at some point
 *   and there is no following answer text yet**; once the final text
 *   arrives it returns to the collapsed default.
 * - The first manual toggle hands control to the user: the primitive's
 *   `collapsed` state then fully decides, overriding the auto behavior.
 */
function ChainOfThoughtInner({ indices, children }: ChainOfThoughtProps) {
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState(
    (s) => s.chainOfThought.status?.type === "running",
  );
  const collapsed = useAuiState((s) => s.chainOfThought.collapsed);

  // 该组是否曾经运行过：锁存，随分组身份（indices[0]）变化重置。
  const wasRunningRef = useRef(false);
  const prevStartIndexRef = useRef(indices[0]);
  useLayoutEffect(() => {
    if (prevStartIndexRef.current !== indices[0]) {
      prevStartIndexRef.current = indices[0];
      wasRunningRef.current = false;
      return;
    }
    if (running) wasRunningRef.current = true;
  }, [indices, running]);

  const label = summarizeChainOfThought(parts, indices);
  const autoOpen = wasRunningRef.current && !hasTextAfterGroup(parts, indices);

  // 用户手动开关：首次点击后由 primitive 的 collapsed 完全决定展示。
  const engagedRef = useRef(false);
  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    engagedRef.current = true;
  };

  const visuallyOpen = engagedRef.current ? !collapsed : running || autoOpen;

  // 整个 children（reasoning + tool-call）是一个统一的滚动容器：内容超出
  // max-h-64 后纵向滚动；仅当 chain-of-thought 正处于流式运行且展开可见时自动
  // 追底（进预览即追底、内容增长持续追底、用户向上滚动暂停、回到底部恢复）。
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPreview = running && visuallyOpen;

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;
    // 写入合并到 rAF：一帧最多一次 `scrollTop = scrollHeight`，避免折叠
    // 动画/流式增长期间多路同步写入互相竞争造成布局抖动与页面闪烁。
    return followResizingContentToBottom(scrollEl, contentEl, {
      respectUserScroll: true,
    });
  }, [isPreview]);

  return (
    <ChainOfThoughtPrimitive.Root
      data-slot="aui_chain-of-thought"
      data-state={visuallyOpen ? "open" : "closed"}
      className={cn(
        "aui-chain-of-thought-root border-none bg-background/90 my-3 overflow-hidden rounded-xl border ",
      )}
      style={
        { "--animation-duration": `${ANIMATION_DURATION}ms` } as CSSProperties
      }
    >
      <ChainOfThoughtPrimitive.AccordionTrigger
        data-slot="aui_chain-of-thought-trigger"
        onClick={handleTriggerClick}
        className={cn(
          "aui-chain-of-thought-trigger group/trigger flex w-fit-content cursor-pointer items-center gap-1.5 py-1.5 text-start text-sm font-medium transition-[background-color,color,scale] active:scale-[0.98]",
        )}
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
            visuallyOpen ? "rotate-0" : "-rotate-90",
          )}
        />
      </ChainOfThoughtPrimitive.AccordionTrigger>

      <Collapsible open={visuallyOpen}>
        <CollapsibleContent
          data-slot="aui_chain-of-thought-content"
          className={cn(
            "aui-chain-of-thought-content relative overflow-hidden outline-none",
            "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
            "data-closed:animate-collapsible-up",
            "data-open:animate-collapsible-down",
            "data-closed:fill-mode-forwards",
            "data-closed:pointer-events-none",
            "data-open:duration-(--animation-duration)",
            "data-closed:duration-(--animation-duration)",
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
            <div ref={contentRef} className={cn("flex flex-col gap-1")}>
              {children}
            </div>
          </div>
          {isPreview ? <ReasoningFade /> : null}
        </CollapsibleContent>
      </Collapsible>
    </ChainOfThoughtPrimitive.Root>
  );
}

export const ChainOfThought: FC<ChainOfThoughtProps> = ({
  indices,
  children,
}) => {
  const startIndex = indices[0];
  const endIndex = indices.at(-1);
  if (
    startIndex === undefined ||
    endIndex === undefined ||
    endIndex < startIndex
  ) {
    return null;
  }

  return (
    <ChainOfThoughtByIndicesProvider
      startIndex={startIndex}
      endIndex={endIndex}
    >
      <ChainOfThoughtInner indices={indices} children={children} />
    </ChainOfThoughtByIndicesProvider>
  );
};
