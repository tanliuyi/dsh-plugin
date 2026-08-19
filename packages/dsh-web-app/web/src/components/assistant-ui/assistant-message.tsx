import { useContext } from "react";
import {
  groupPartByType,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { LoaderCircleIcon, TerminalIcon } from "lucide-react";

import { AssistantActionBar } from "@/components/assistant-ui/assistant-action-bar";
import { ChainOfThought } from "@/components/assistant-ui/chain-of-thought";
import { CompactionMessage } from "@/components/assistant-ui/compaction-message";
import { ContextMessageSurface } from "@/components/assistant-ui/context-message-surface";
import { File } from "@/components/assistant-ui/file";
import { Image } from "@/components/assistant-ui/image";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { MessageError } from "@/components/assistant-ui/message-error";
import { PendingSteeringBeforeLoader } from "@/components/assistant-ui/pending-steering-before-loader";
import { Reasoning } from "@/components/assistant-ui/reasoning";
import {
  SteeringImageList,
  type SteeringImage,
} from "@/components/assistant-ui/steering-image-list";
import { ThreadComponentsContext } from "@/components/assistant-ui/thread-components-context";
import { ThreadGenerationLoader } from "@/components/assistant-ui/thread-generation-loader";
import { AssistantTodoToolCall } from "@/components/assistant-ui/todo-row";
import { AssistantToolCall } from "@/components/assistant-ui/tool-call";
import { UserMessageSurface } from "@/components/assistant-ui/user-message-surface";
import { ErrorState } from "@/components/elements/error-state";
import type { DshMessagePart } from "@/dsh/messages";
import { cn } from "@/lib/utils";

const ASSISTANT_PART_GROUPER = groupPartByType({
  reasoning: ["group-chainOfThought"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

export function AssistantMessage() {
  const { ToolFallback: ToolFallbackComponent = AssistantToolCall, ToolGroup } =
    useContext(ThreadComponentsContext);
  const hasSteeringData = useAuiState((state) =>
    state.message.content.some(
      (part) => part.type === "data" && part.name === "dsh-steering",
    ),
  );
  const actionBarHeight = "min-h-7.5 pt-1.5";

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          indicator="always"
          groupBy={ASSISTANT_PART_GROUPER}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return (
                  <ChainOfThought indices={part.indices}>{children}</ChainOfThought>
                );
              case "group-tool":
                return ToolGroup ? (
                  <ToolGroup group={part}>{children}</ToolGroup>
                ) : (
                  <>{children}</>
                );
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                if (part.toolUI) return part.toolUI;
                if (part.toolName === "todo_write") {
                  return <AssistantTodoToolCall {...part} />;
                }
                return <ToolFallbackComponent {...part} />;
              case "data":
                if (part.name === "dsh-command") {
                  const command =
                    (
                      part as {
                        data?: {
                          commandName?: string | null;
                          outcome?: {
                            kind?: "success" | "error";
                            text?: string;
                          } | null;
                          compaction?: Extract<
                            DshMessagePart,
                            { type: "compaction" }
                          >;
                        };
                      }
                    ).data ?? {};
                  if (command.compaction) {
                    return (
                      <CompactionMessage
                        compaction={command.compaction}
                        title="compact"
                        fallbackSummary={command.outcome?.text}
                      />
                    );
                  }
                  const running = command.outcome == null;
                  const failed = command.outcome?.kind === "error";
                  const summary = running
                    ? "Running command"
                    : (command.outcome?.text ??
                      (failed ? "Command failed" : "Command completed"));
                  return (
                    <div
                      data-slot="aui_command"
                      data-state={running ? "running" : failed ? "error" : "complete"}
                      className="border-border/50 bg-muted/25 my-1 flex min-h-8 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                      role="status"
                    >
                      {running ? (
                        <LoaderCircleIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
                      ) : (
                        <TerminalIcon
                          className={cn(
                            "size-3.5 shrink-0",
                            failed ? "text-destructive" : "text-muted-foreground",
                          )}
                        />
                      )}
                      <span className="font-medium">
                        {command.commandName ?? "command"}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          failed ? "text-destructive" : "text-muted-foreground",
                        )}
                        title={summary}
                      >
                        {summary}
                      </span>
                    </div>
                  );
                }
                if (part.name === "dsh-compaction") {
                  const compaction = (
                    part as {
                      data?: Extract<DshMessagePart, { type: "compaction" }>;
                    }
                  ).data;
                  return compaction ? (
                    <CompactionMessage compaction={compaction} />
                  ) : null;
                }
                if (part.name === "dsh-generation-status") {
                  const status =
                    (
                      part as {
                        data?: {
                          state?: "error" | "retrying";
                          title?: string;
                          detail?: string;
                        };
                      }
                    ).data ?? {};
                  return (
                    <ErrorState
                      title={status.title ?? "Request failed"}
                      detail={status.detail ?? "The model request failed."}
                      retrying={status.state === "retrying"}
                      className="my-2"
                    />
                  );
                }
                if (part.name === "dsh-context") {
                  const context =
                    (part as { data?: { label?: string; text?: string } }).data ??
                    {};
                  return (
                    <ContextMessageSurface
                      context={{
                        type: "context",
                        label: context.label ?? "context",
                        text: context.text ?? "",
                      }}
                    />
                  );
                }
                if (part.name === "dsh-steering") {
                  const steering =
                    (
                      part as {
                        data?: { text?: string; images?: SteeringImage[] };
                      }
                    ).data ?? {};
                  return (
                    <UserMessageSurface
                      text={steering.text ?? ""}
                      media={
                        <SteeringImageList images={steering.images ?? []} />
                      }
                      kind="steering"
                    />
                  );
                }
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                if (hasSteeringData) return null;
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <ThreadGenerationLoader
                    before={<PendingSteeringBeforeLoader />}
                  />
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      {!hasSteeringData && (
        <div
          data-slot="aui_assistant-message-footer"
          className={cn("ms-2 flex items-center", actionBarHeight)}
        >
          <AssistantActionBar />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
