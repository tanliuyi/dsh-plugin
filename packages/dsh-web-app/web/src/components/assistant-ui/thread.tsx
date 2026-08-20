"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/attachment";
import type { SteeringImage } from "@/components/assistant-ui/steering-image-list";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/follow-up-suggestions";
import {
  EMPTY_THREAD_COMPONENTS,
  ThreadComponentsContext,
  type ThreadComponents,
} from "@/components/assistant-ui/thread-components-context";
import { ThreadLoading } from "@/components/assistant-ui/thread-loading";
import { ThreadMessage } from "./thread-message";
import { PlanReviewPanel } from "@/components/assistant-ui/plan-review-panel";
import { TodoPanel } from "@/components/assistant-ui/todo-panel";
import { VirtualizedThreadMessages } from "@/components/assistant-ui/virtualized-thread-messages";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { UserMessageSurface } from "@/components/assistant-ui/user-message-surface";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApprovalCard } from "@/components/approval-card";
import {
  ElicitationForm,
  type ElicitationField,
} from "@/components/elicitation-form";
import { MessageQueue } from "@/components/message-queue";
import { ComposerTriggerPopover } from "@/components/composer-trigger-popover";
import { ComposerContext } from "@/components/composer";
import {
  STOP_ARM_WINDOW_MS,
  advanceEsc,
  primaryActionOf,
} from "@/components/composer-stop";
import { ModelSelector } from "@/components/model-selector";
import { Select, type SelectOption } from "@/components/select";
import { useDsh } from "@/dsh/store";
import { planReviewOf } from "@/dsh/plan-review";
import type { Question } from "@/dsh/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  $isDirectiveNode,
  LexicalComposerInput,
  type DirectiveChipProps,
} from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
} from "lexical";
import {
  AuiIf,
  unstable_defaultDirectiveFormatter,
  unstable_useSlashCommandAdapter,
  type AssistantState,
  type Unstable_DirectiveFormatter,
  ComposerPrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SquareIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type {
  ThreadComponents,
  ThreadGroupPart,
} from "@/components/assistant-ui/thread-components-context";

export type ThreadProps = {
  components?: ThreadComponents | undefined;
};

type ThreadRootProps = ThreadProps & {
  sessionId?: string | undefined;
  hydrated?: boolean | undefined;
};

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_THREAD_COMPONENTS,
}) => {
  const booting = useDsh((s) => s.booting);

  if (booting) return <ThreadLoading />;

  return <ThreadRoot components={components} />;
};

/** Route-owned thread root; remounting it resets the viewport for each session. */
export const ThreadRoot: FC<ThreadRootProps> = ({
  components = EMPTY_THREAD_COMPONENTS,
  sessionId,
  hydrated = true,
}) => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const loadingHistory = useDsh((s) => s.loadingHistory);
  // An empty message buffer is an intermediate hydration state, not a new chat.
  const sessionReady =
    sessionId === undefined || currentSessionId === sessionId;
  const isHydrating =
    sessionId !== undefined && (!sessionReady || !hydrated || loadingHistory);
  const isEmpty =
    useAuiState(isNewChatView) && sessionReady && hydrated && !loadingHistory;

  if (isHydrating) return <ThreadLoading />;

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRootContent isEmpty={isEmpty} />
    </ThreadComponentsContext.Provider>
  );
};

const useInitialInstantBottom = () => {
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const previousScrollBehavior = viewport.style.scrollBehavior;
    const fontSet = document.fonts;
    let fontsReady = fontSet.status === "loaded";
    let stopped = false;
    let frame = 0;
    let quietTimer = 0;
    let maxTimer = 0;

    const pinToBottom = () => {
      viewport.style.scrollBehavior = "auto";
      viewport.scrollTop = viewport.scrollHeight;
    };
    const imagesReady = () =>
      Array.from(viewport.querySelectorAll<HTMLImageElement>("img")).every(
        (image) => image.complete,
      );
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(quietTimer);
      window.clearTimeout(maxTimer);
      observer.disconnect();
      viewport.style.scrollBehavior = previousScrollBehavior;
      viewport.removeEventListener("load", schedulePin, true);
      viewport.removeEventListener("pointerdown", stop);
      viewport.removeEventListener("wheel", stop);
      viewport.removeEventListener("touchstart", stop);
    };
    const schedulePin = () => {
      if (stopped) return;
      // ResizeObserver runs before paint. Pin synchronously so hydrated messages
      // never render at the top for one frame before the next RAF catches up.
      pinToBottom();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        pinToBottom();
        if (!fontsReady || !imagesReady()) return;
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => {
          pinToBottom();
          stop();
        }, 1_500);
      });
    };
    const observer = new ResizeObserver(schedulePin);

    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    viewport.addEventListener("load", schedulePin, true);
    viewport.addEventListener("pointerdown", stop);
    viewport.addEventListener("wheel", stop, { passive: true });
    viewport.addEventListener("touchstart", stop, { passive: true });
    void fontSet.ready.then(() => {
      fontsReady = true;
      schedulePin();
    });
    maxTimer = window.setTimeout(() => {
      pinToBottom();
      stop();
    }, 5_000);

    pinToBottom();
    schedulePin();
    return stop;
  }, []);

  return viewportRef;
};

const ThreadRootContent: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const viewportRef = useInitialInstantBottom();
  const showNewChat = (state: AssistantState) =>
    isEmpty && isNewChatView(state);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="bottom"
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnThreadSwitch={false}
        scrollToBottomOnInitialize={false}
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={showNewChat}>
            <Welcome />
          </AuiIf>

          {!isEmpty && (
            <div data-slot="aui_message-group" className="mb-14">
              <VirtualizedThreadMessages
                viewportRef={viewportRef}
                messageComponent={ThreadMessage}
              />
            </div>
          )}

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col items-start justify-start gap-1 w-full overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />

            <ThreadFollowupSuggestions />

            <TodoPanel />

            <PendingInteractionCards />

            <GoalBar />

            <QueueDock />

            <Composer />
            <AuiIf condition={showNewChat}>
              <div
                data-slot="aui_thread-suggestions-spacer"
                className="min-h-8"
              >
                <AuiIf condition={(s) => s.composer.isEmpty}>
                  <ThreadSuggestions />
                </AuiIf>
              </div>
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

/**
 * GoalBar: the goal indicator docked above the composer, mirroring the
 * upstream ui-goal strip. A present goal shows a goal glyph, a phase label,
 * the truncated objective, and icon actions — resume when paused, edit
 * (inline form in the same strip), and clear. Creation lives on the `/goal`
 * command, not here: no goal (null), loading (undefined), and complete goals
 * render nothing. Live state arrives as the projected whole snapshot; the
 * verbs go through the store goal RPCs with the CAS ref read at call time.
 */
const GOAL_PHASE_LABELS = {
  active: "Ongoing Goal",
  paused: "Paused Goal",
  blocked: "Blocked Goal",
} as const;

const GoalBar: FC = () => {
  const projection = useDsh((s) => s.goal);
  const pause = useDsh((s) => s.pauseGoal);
  const resume = useDsh((s) => s.resumeGoal);
  const clear = useDsh((s) => s.clearGoal);
  const edit = useDsh((s) => s.editGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearedGoalId, setClearedGoalId] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const goal = projection?.goal;
  const goalId = goal?.id;

  // A new goal identity (cleared/completed/replaced externally) invalidates
  // the local edit state: without the reset a surviving draft's Enter would
  // write over the NEW goal.
  useEffect(() => {
    setEditing(false);
    setActionError(null);
    setClearedGoalId(null);
  }, [goalId]);

  // React state disables the controls on the next render; the ref closes the
  // same-render window so rapid clicks cannot submit the same CAS twice.
  const runAction = async (action: () => Promise<void>): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const handleEdit = async () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    const ok = await runAction(async () => {
      await edit(trimmed);
    });
    if (ok) setEditing(false);
  };

  const handleClear = async () => {
    if (!goal) return;
    const ok = await runAction(clear);
    // Suppress this exact goal id while the authoritative null projection
    // catches up after the clear.
    if (ok) setClearedGoalId(goal.id);
  };

  // Loading, absent, completed, and freshly-cleared goals have no strip.
  if (!goal || goal.phase === "complete" || goal.id === clearedGoalId)
    return null;

  if (editing) {
    return (
      <div
        data-slot="aui_goal_bar"
        className="mx-auto flex min-h-9 w-full max-w-[96%] items-center gap-2 overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3 py-1 text-[13px]"
      >
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <TargetIcon className="size-3.5" />
        </span>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleEdit();
            if (event.key === "Escape") setEditing(false);
          }}
          autoFocus
          className="h-7 min-w-0 flex-1 text-xs"
          aria-label="Goal objective"
        />
        {actionError !== null ? (
          <span
            role="alert"
            className="text-destructive max-w-64 shrink-0 truncate"
            title={actionError}
          >
            {actionError}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          <TooltipIconButton
            tooltip="Save goal"
            aria-label="Save goal"
            disabled={pending || draft.trim() === ""}
            onClick={() => void handleEdit()}
          >
            <CheckIcon className="size-3.5" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Cancel edit"
            aria-label="Cancel edit"
            disabled={pending}
            onClick={() => setEditing(false)}
          >
            <XIcon className="size-3.5" />
          </TooltipIconButton>
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="aui_goal_bar"
      className="mx-auto flex min-h-9 w-full max-w-[96%] items-center gap-2 overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3 py-1.5 text-[13px]"
      title={goal.phase === "blocked" ? goal.blockedReason?.message : undefined}
    >
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      >
        <TargetIcon className="size-3.5" />
      </span>
      <span className="shrink-0 font-medium">
        {GOAL_PHASE_LABELS[goal.phase]}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {goal.objective}
      </span>
      {actionError !== null ? (
        <span
          role="alert"
          className="text-destructive max-w-64 shrink-0 truncate"
          title={actionError}
        >
          {actionError}
        </span>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5">
        {goal.phase === "active" ? (
          <TooltipIconButton
            tooltip="Pause goal"
            aria-label="Pause goal"
            disabled={pending}
            onClick={() => void runAction(pause)}
          >
            <PauseIcon className="size-3.5" />
          </TooltipIconButton>
        ) : null}
        {goal.phase === "paused" ? (
          <TooltipIconButton
            tooltip="Resume goal"
            aria-label="Resume goal"
            disabled={pending}
            onClick={() => void runAction(resume)}
          >
            <PlayIcon className="size-3.5" />
          </TooltipIconButton>
        ) : null}
        <TooltipIconButton
          tooltip="Edit goal"
          aria-label="Edit goal"
          disabled={pending}
          onClick={() => {
            setDraft(goal.objective);
            setEditing(true);
          }}
        >
          <PencilIcon className="size-3.5" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="Clear goal"
          aria-label="Clear goal"
          disabled={pending}
          onClick={() => void handleClear()}
        >
          <Trash2Icon className="size-3.5" />
        </TooltipIconButton>
      </div>
    </div>
  );
};

function commandForCall(
  messages: DshMessage[],
  callId?: string,
): string | undefined {
  if (!callId) return undefined;
  for (const message of messages) {
    const part = message.parts.find(
      (item) => item.type === "tool" && item.callId === callId,
    );
    if (!part || part.type !== "tool") continue;
    if (
      typeof part.args === "object" &&
      part.args !== null &&
      typeof (part.args as { command?: unknown }).command === "string"
    ) {
      return (part.args as { command: string }).command;
    }
    if (typeof part.args === "string") {
      try {
        const parsed = JSON.parse(part.args) as { command?: unknown };
        if (typeof parsed.command === "string") return parsed.command;
      } catch {
        return part.args;
      }
    }
  }
  return undefined;
}

const PendingInteractionCards: FC = () => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const pendingInteractions = useDsh((s) => s.pendingInteractions);
  const pending = useMemo(
    () =>
      pendingInteractions.filter((item) => item.sessionId === currentSessionId),
    [currentSessionId, pendingInteractions],
  );
  const respond = useDsh((s) => s.respondToInteraction);
  const messages = useDsh((s) => s.messages);

  // 无待处理交互时不渲染，避免空容器占位。
  if (pending.length === 0) return null;

  return (
    <div className="flex w-full flex-col items-stretch gap-3">
      {pending.map((item) => {
        if (item.kind === "question") {
          return (
            <QuestionInteraction
              key={item.rpcId}
              interaction={{
                rpcId: item.rpcId,
                sessionId: item.sessionId,
                payload: item.payload as { questions: Question[] },
              }}
              onRespond={respond}
            />
          );
        }
        const approval = item.payload as {
          approvalId: string;
          toolName: string;
          callId?: string;
          command?: string;
          reason?: string;
        };
        const answer = (outcome: "allowed-once" | "rejected") =>
          respond(item.rpcId, {
            ok: true,
            value: {
              sessionId: item.sessionId,
              approvalId: approval.approvalId,
              outcome,
            },
          });
        return (
          <ApprovalCard
            key={item.rpcId}
            state="request"
            command={
              approval.command ?? commandForCall(messages, approval.callId)
            }
            title="等待审批"
            subtitle={approval.reason ?? `需要批准 ${approval.toolName}`}
            onAllowOnce={() => answer("allowed-once")}
            onDeny={() => answer("rejected")}
          />
        );
      })}
    </div>
  );
};

function parseRecommendedLabel(label: string): {
  label: string;
  recommended: boolean;
} {
  const suffix =
    /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return suffix.test(label)
    ? { label: label.replace(suffix, ""), recommended: true }
    : { label, recommended: false };
}

const QuestionInteraction: FC<{
  interaction: {
    rpcId: string;
    sessionId: string;
    payload: { questions: Question[] };
  };
  onRespond: (
    rpcId: string,
    result: { ok: boolean; value?: unknown; error?: unknown },
  ) => Promise<void>;
}> = ({ interaction, onRespond }) => {
  type Draft = { selected: string[]; custom: string };
  const questions = interaction.payload.questions;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // plan-review 呈现意图（对齐上游 ui-user-questions contract/slots.ts）：
  // 命中即渲染专用接管面板（单一问题 + plan 正文做一张决策卡）；未命中才走
  // 通用提问表单，generic 流程保持原样。认领守卫由 planReviewOf 承担。
  const planReview = useMemo(() => planReviewOf(questions), [questions]);
  const fields: ElicitationField[] = questions.map((question) => {
    const draft = drafts[question.id] ?? { selected: [], custom: "" };
    return {
      name: question.id,
      label: question.header ?? question.question,
      value: draft.selected.join(", "),
      customValue: draft.custom,
      selected: draft.selected,
      kind: question.options?.length ? "choice" : "text",
      multiSelect: question.multiSelect === true,
      allowCustom: true,
      customPlaceholder: "输入你的答案",
      options: question.options?.map((option) => {
        const parsed = parseRecommendedLabel(option.label);
        return {
          value: option.label,
          label: parsed.label,
          description: option.description,
          recommended: parsed.recommended,
        };
      }),
      required: true,
    };
  });
  const updateCustom = (name: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [name]: {
        ...(current[name] ?? { selected: [], custom: "" }),
        custom: value,
      },
    }));
  };
  const update = (name: string, value: string) => {
    const question = questions.find((item) => item.id === name);
    if (!question) return;
    setDrafts((current) => {
      const previous = current[name] ?? { selected: [], custom: "" };
      if (!question.options?.length)
        return { ...current, [name]: { selected: [], custom: value } };
      const selected = question.multiSelect
        ? previous.selected.includes(value)
          ? previous.selected.filter((item) => item !== value)
          : [...previous.selected, value]
        : [value];
      return { ...current, [name]: { selected, custom: "" } };
    });
  };
  const answer = () => {
    void onRespond(interaction.rpcId, {
      ok: true,
      value: {
        sessionId: interaction.sessionId,
        answer: {
          answers: questions.map((question) => {
            const draft = drafts[question.id] ?? { selected: [], custom: "" };
            return {
              id: question.id,
              selected:
                draft.custom && !question.multiSelect ? [] : draft.selected,
              ...(draft.custom ? { custom: draft.custom } : {}),
            };
          }),
        },
      },
    });
  };
  // 命中 plan-review：接管面板能送出该请求允许的每一个答案，直接渲染决策卡。
  if (planReview) {
    return (
      <PlanReviewPanel
        rpcId={interaction.rpcId}
        sessionId={interaction.sessionId}
        review={planReview}
        onRespond={onRespond}
      />
    );
  }
  return (
    <ElicitationForm
      server="Agent"
      message={questions.map((question) => question.question).join(" ")}
      fields={fields}
      state="request"
      onFieldChange={update}
      onCustomChange={updateCustom}
      onAccept={answer}
      onDecline={() =>
        void onRespond(interaction.rpcId, {
          ok: false,
          error: {
            code: "cancelled",
            message: "the user closed this question request",
            details: {},
          },
        })
      }
    />
  );
};

const QueueDock: FC = () => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const queueSessionId = useDsh((s) => s.queueSessionId);
  const queueItems = useDsh((s) => s.queueItems);
  const cancel = useDsh((s) => s.onCancelQueueItem);
  const steer = useDsh((s) => s.onSteerQueueItem);
  const queued = queueItems.filter((item) => item.placement === "queued");
  // Queue snapshots remain actionable after a turn is cancelled or settles.
  if (queueSessionId !== currentSessionId || queued.length === 0) {
    return null;
  }
  return (
    <MessageQueue
      queued={queued}
      onCancel={(id) => void cancel(id)}
      onSteer={(id) => void steer(id)}
    />
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const NewSessionControls: FC = () => {
  const workspaces = useDsh((s) => s.workspaces);
  const hostCwd = useDsh((s) => s.host?.cwd);
  const presets = useDsh((s) => s.agentPresets);
  const workspaceId = useDsh((s) => s.newSessionWorkspaceId);
  const agentPreset = useDsh((s) => s.newSessionAgentPreset);
  const setWorkspace = useDsh((s) => s.setNewSessionWorkspace);
  const setAgentPreset = useDsh((s) => s.setNewSessionAgentPreset);

  const workspaceOptions: SelectOption[] = workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.title,
    textValue: `${workspace.title} ${workspace.path}`,
  }));
  const fallbackWorkspace = hostCwd
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  if (!workspaceOptions.length && fallbackWorkspace) {
    workspaceOptions.push({ value: "__host__", label: fallbackWorkspace });
  }
  const presetOptions: SelectOption[] = presets
    .filter((preset) => !preset.broken)
    .map((preset) => ({
      value: preset.id,
      label: (
        <span className="flex max-w-64 flex-col items-start text-left">
          <span>{preset.name ?? preset.id}</span>
          {preset.description && (
            <span className="text-muted-foreground line-clamp-2 text-xs">
              {preset.description}
            </span>
          )}
        </span>
      ),
      triggerLabel: preset.name ?? preset.id,
      textValue: `${preset.name ?? preset.id} ${preset.description ?? ""}`,
    }));

  return (
    <div className="aui-new-session-drawer -mb-4 h-11 w-full overflow-hidden rounded-t-2xl border border-border/60 border-b-0 bg-muted/45 px-3 py-1 shadow-[0_-2px_10px_-8px_rgba(0,0,0,0.25)]">
      <div className="flex h-7 flex-wrap items-center gap-1.5">
        {workspaceOptions.length > 0 && (
          <Select
            value={workspaceId ?? workspaceOptions[0]!.value}
            onValueChange={(value) =>
              setWorkspace(value === "__host__" ? "" : value)
            }
            options={workspaceOptions}
            className="h-7 max-w-48 items-center px-2 py-1 text-xs"
            placeholder="Workspace"
          />
        )}
        {presetOptions.length > 0 && (
          <Select
            value={agentPreset ?? presetOptions[0]!.value}
            onValueChange={(value) =>
              void setAgentPreset(value).catch(() => {})
            }
            options={presetOptions}
            className="h-7 max-w-64 items-center px-2 py-1 text-xs"
            placeholder="Mode"
          />
        )}
      </div>
    </div>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-2 flex flex-col items-center gap-4 px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        How can I help you today?
      </h1>
      <NewSessionControls />
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC = () => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const hasPendingInteraction = useDsh((s) =>
    s.pendingInteractions.some((item) => item.sessionId === currentSessionId),
  );
  const aui = useAui();
  const slash = useSlashCommands();

  // 双 Esc 停止：第一次 Esc 只布防（按钮临时变成 "Esc" 提示）并开启 1 秒窗口；
  // 窗口内第二次 Esc 才真正停止。armed 状态放在 Root 之上，capture 键盘处理和
  // 右侧按钮都能读写它。ref 与 state 同步，handler 里读 ref 避免闭包过期。
  const [escArmed, setEscArmed] = useState(false);
  const escArmedRef = useRef(false);
  const disarmTimerRef = useRef<number | null>(null);

  const disarmEsc = useCallback(() => {
    escArmedRef.current = false;
    setEscArmed(false);
    if (disarmTimerRef.current !== null) {
      window.clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
  }, []);

  const scheduleEscDisarm = useCallback(() => {
    if (disarmTimerRef.current !== null)
      window.clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = window.setTimeout(() => {
      disarmTimerRef.current = null;
      disarmEsc();
    }, STOP_ARM_WINDOW_MS);
  }, [disarmEsc]);

  // 运行中状态变化：turn 若在窗口期内自然结束（停止/取消/完成），立即解除布防，
  // 避免下一次运行被残留的第二次 Esc 误停；卸载时清理定时器。
  const running = useAuiState((s) => s.thread.isRunning);
  const composerEmpty = useAuiState((s) => s.composer.isEmpty);
  useEffect(() => {
    if (!running) disarmEsc();
  }, [running, disarmEsc]);
  useEffect(() => disarmEsc, [disarmEsc]);

  const sendSteer = () => {
    // 复用现有 Send 漏斗（附件上传 / 清空 / 失败草稿恢复与 idle 完全一致）：
    // 运行中 DshRuntime.onNew 依据 isRunning 把本次提交落成 mode:'steer'。
    // send() 返回 void：派发失败由 composer 核心内部恢复草稿（_restoreUnsentDraft），
    // 这里既不能也无须 .catch。
    aui.composer.send();
  };

  const stopRunning = () => {
    aui.composer.cancel();
    disarmEsc();
  };

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !event.currentTarget.contains(target)
    )
      return;
    if (event.nativeEvent.isComposing) return;

    if (event.key === "Enter") {
      // running 且输入非空时，Enter 直接注入 steer 引导消息（原本会换行）。
      // 修饰键组合保持原语义：Shift+Enter 换行、Cmd/Ctrl+Enter 等交给编辑器；
      // 焦点在按钮上时不劫持（保留按钮原生 Enter=点击）。
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (target.closest("button")) return;
      if (!running || composerEmpty) return;
      // 斜杠指令 / 提及浮层打开时，回车用于选中高亮项（Unstable_TriggerPopover
      // 在 data-state="open" 时渲染带 [data-slot="composer-trigger-popover"] 的
      // 容器）；此刻不劫持，避免破坏命令选择后再回车发送。
      if (
        event.currentTarget.querySelector(
          '[data-slot="composer-trigger-popover"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      sendSteer();
      return;
    }

    if (event.key === "Escape") {
      // 单次 Esc 绝不误停：只布防；1 秒窗口内第二次 Esc 才停止。运行结束自动解除。
      if (!running) {
        disarmEsc();
        return;
      }
      // 必须先吞掉这一次 Esc：Lexical 输入默认 cancelOnEscape，running 时
      // 单次 Esc 会立即 composer.cancel()（capabilities.cancel 恒为 true），
      // 若放行则双 Esc 的第一次就误停，布防窗口形同虚设。
      event.preventDefault();
      event.stopPropagation();
      const transition = advanceEsc(escArmedRef.current, true);
      escArmedRef.current = transition.armed;
      setEscArmed(transition.armed);
      if (transition.stop) {
        stopRunning();
      } else {
        scheduleEscDisarm();
      }
    }
  };

  const handlePaste = async (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!aui.thread.getState().capabilities.attachments || files.length === 0)
      return;
    event.preventDefault();
    await Promise.all(
      files.map(async (file) => {
        try {
          await aui.composer.addAttachment(file);
        } catch {
          // Attachment adapters report upload errors through composer state.
        }
      }),
    );
  };

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        className={cn(
          "aui-composer-root relative flex w-full flex-col",
          hasPendingInteraction && "hidden",
        )}
        onKeyDownCapture={handleKeyDownCapture}
      >
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
          >
            <ComposerAttachments />
            <LexicalComposerInput
              placeholder="Send a message..."
              className="aui-composer-input text-foreground caret-primary placeholder:text-sm placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full bg-transparent text-sm outline-none"
              autoFocus
              submitMode="enter"
              aria-label="Message input"
              directiveChip={SlashDirectiveChip}
              onPaste={handlePaste}
              children={<SlashCommandPlaceholderPlugin />}
            />
            <ComposerAction
              armed={escArmed}
              onSteer={sendSteer}
              onCancel={stopRunning}
            />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
        <ComposerTriggerPopover
          char="/"
          adapter={slash.adapter}
          directive={slash.directive}
          fallbackIcon={TerminalIcon}
          emptyItemsLabel="没有匹配的命令"
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

const useSlashCommands = () => {
  const aui = useAui();
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const executeCommand = useDsh((s) => s.executeCommand);
  const dynamicCommands = useDsh((s) => s.commands);
  // 菜单只显示匹配当前 session 的 skills：store open 已清空跨会话残留，且
  // skillsSessionId 必须等于 currentSessionId（旧 session 晚到的目录不得显示）。
  const skillsSessionId = useDsh((s) => s.skillsSessionId);
  const skills = useDsh((s) => s.skills);
  const commands = useMemo(() => {
    const commandItems = dynamicCommands.map((command) => ({
      id: command.name,
      label: `/${command.name}`,
      description: command.description ?? "",
      execute: () => {
        // no-op：满足 adapter 类型。bare command 的 insert 语义由 directive.onInserted
        // 唯一负责（execute 只在菜单选中时触发一次，这里无需重复执行）。
      },
    }));
    // skill 目录（上游 ui-skill / skill.list）：用户可调用的 /name 条目。
    // 调用本身是一次普通 session.prompt，宿主导出预置注入 <skill_content>；
    // 这里仅让它们出现在斜杠菜单里（指令插入模式会填入 `/name`）。
    // 与 host command 同名的 skill 被过滤：command 优先，避免菜单出现两行同名项。
    const commandNames = new Set(
      dynamicCommands.map((command) => command.name),
    );
    const skillItems = (skillsSessionId === currentSessionId ? skills : [])
      .filter((skill) => !commandNames.has(skill.name))
      .map((skill) => ({
        id: `skill:${skill.name}`,
        label: `/${skill.name}`,
        description: skill.description ?? "",
        execute: () => {
          // no-op：directive 插入 `/name`，回车后走普通 prompt，宿主识别 skill 注入。
        },
      }));
    return [...commandItems, ...skillItems];
  }, [currentSessionId, dynamicCommands, skills, skillsSessionId]);
  const slash = unstable_useSlashCommandAdapter({ commands });
  // 防抖：同一 bare command 的 onInserted 只执行一次（直到该次 execute 落定）。
  const executingBareCommand = useRef<string | null>(null);
  return {
    adapter: slash.adapter,
    directive: {
      formatter: slashDirectiveFormatter,
      onInserted: (item: { id: string }) => {
        const command = dynamicCommands.find((entry) => entry.name === item.id);
        // input command：保留 directive，让用户继续输入参数（不 execute）。
        if (command?.input !== undefined) return;
        // skill/未知项：保留 directive，回车走普通 prompt。
        if (command === undefined) return;
        if (executingBareCommand.current === item.id) return;
        executingBareCommand.current = item.id;
        // Bare command picks are detached actions: consume the inserted token
        // immediately, then execute exactly once and clear the composer.
        aui.composer.setText("");
        void executeCommand(`/${command.name}`)
          .catch((cause) => {
            useDsh.setState({
              error: cause instanceof Error ? cause.message : String(cause),
            });
          })
          .finally(() => {
            if (executingBareCommand.current === item.id)
              executingBareCommand.current = null;
          });
      },
    },
  };
};

const slashCommandHints: Record<string, string> = {
  goal: "输入目标，智能体将持续执行",
  permission: "选择权限模式",
  plan: "描述你的任务以生成计划",
};

const SlashDirectiveChip: FC<DirectiveChipProps> = ({ directiveId, label }) => (
  <span className="aui-directive-chip" data-directive-id={directiveId}>
    <span className="aui-directive-chip-label">{label}</span>
  </span>
);

type PlaceholderPosition = {
  text: string;
  left: number;
  top: number;
};

const SlashCommandPlaceholderPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();
  const initializedDirectiveKey = useRef<string | null>(null);
  const [placeholder, setPlaceholder] = useState<PlaceholderPosition | null>(
    null,
  );

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let directiveKey: string | null = null;
        let needsSpace = false;
        editor.getEditorState().read(() => {
          const root = $getRoot();
          const directiveNode = root
            .getChildren()
            .flatMap((child) =>
              $isElementNode(child) ? child.getChildren() : [],
            )
            .find($isDirectiveNode);
          const item = directiveNode?.getDirectiveItem();
          if (!directiveNode || !item) {
            initializedDirectiveKey.current = null;
          } else if (root.getTextContent() === item.label) {
            directiveKey = directiveNode.getKey();
            const next = directiveNode.getNextSibling();
            needsSpace =
              initializedDirectiveKey.current !== directiveKey &&
              !next?.getTextContent().startsWith(" ");
          }
        });

        if (needsSpace && directiveKey) {
          initializedDirectiveKey.current = directiveKey;
          editor.update(() => {
            const node = $getNodeByKey(directiveKey!);
            if (!$isDirectiveNode(node)) return;
            const next = node.getNextSibling();
            if (next?.getTextContent().startsWith(" ")) return;
            const space = $createTextNode(" ");
            node.insertAfter(space);
            space.select(1, 1);
          });
          return;
        }

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const text = root.getTextContent();
          const directiveNode = root
            .getChildren()
            .flatMap((child) =>
              $isElementNode(child) ? child.getChildren() : [],
            )
            .find($isDirectiveNode);
          const item = directiveNode?.getDirectiveItem();
          const rootElement = editor.getRootElement();
          const chip = rootElement?.querySelector<HTMLElement>(
            ".aui-directive-chip",
          );
          const wrapper = rootElement?.parentElement;

          if (
            !item ||
            !chip ||
            !wrapper ||
            (text !== item.label && text !== `${item.label} `)
          ) {
            setPlaceholder(null);
            return;
          }

          const chipRect = chip.getBoundingClientRect();
          const wrapperRect = wrapper.getBoundingClientRect();
          setPlaceholder({
            text: slashCommandHints[item.id] ?? "",
            left: chipRect.right - wrapperRect.left + 5,
            top: chipRect.top - wrapperRect.top,
          });
        });
      });
    };

    update();
    const unregister = editor.registerUpdateListener(update);
    window.addEventListener("resize", update);
    return () => {
      unregister();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, [editor]);

  if (!placeholder?.text) return null;
  return (
    <span
      aria-hidden="true"
      className="aui-lexical-command-placeholder"
      style={{ left: placeholder.left, top: placeholder.top }}
    >
      {placeholder.text}
    </span>
  );
};

const slashDirectiveFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    return item.label;
  },
  parse: unstable_defaultDirectiveFormatter.parse,
};

const permissionShieldOutline =
  "M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z";

const PermissionGlyph: FC<{ value: string }> = ({ value }) => {
  if (value === "workspace-write") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87675 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959C8.01261 0.268728 8.05076 0.258321 8.08887 0.251709Z"
          fill="currentColor"
        />
        <path
          d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z"
          fill="currentColor"
        />
        <path
          d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z"
          fill="currentColor"
        />
        <path
          d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.414 14.4746 11.5511 14.3547H14.6647V15.6852Z"
          fill="currentColor"
        />
        <path
          d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={permissionShieldOutline}
        stroke="currentColor"
        strokeWidth="1.31831"
        strokeLinejoin="round"
      />
      {value === "danger-full-access" ? (
        <>
          <path
            d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z"
            fill="currentColor"
          />
          <path
            d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z"
            fill="currentColor"
          />
        </>
      ) : (
        <path
          d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z"
          fill="currentColor"
        />
      )}
    </svg>
  );
};

const PermissionSelectorAction: FC = () => {
  const permissions = useDsh((s) => s.permissions);
  const setPermissionPreset = useDsh((s) => s.setPermissionPreset);
  const [pendingFullAccess, setPendingFullAccess] = useState(false);

  if (!permissions || permissions.options.length === 0) return null;

  const labelOf = (value: string) => {
    if (value === "read-only") return "Read Only";
    if (value === "workspace-write") return "Workspace Write";
    if (value === "danger-full-access") return "Full access";
    return value
      .replace(
        /(^|-)([a-z])/g,
        (_, _dash, letter) => ` ${letter.toUpperCase()}`,
      )
      .trim();
  };
  const iconOf = (value: string) => <PermissionGlyph value={value} />;
  const options: SelectOption[] = permissions.options.map((option) => ({
    value: option.value,
    label: (
      <span className="flex items-center gap-2">
        {iconOf(option.value)}
        {labelOf(option.value)}
      </span>
    ),
    triggerLabel: (
      <span className="flex items-center gap-1.5">
        {iconOf(option.value)}
        {labelOf(option.value)}
      </span>
    ),
  }));
  const current = permissions.currentValue;

  const choose = (value: string) => {
    if (value === "danger-full-access" && current !== value) {
      setPendingFullAccess(true);
      return;
    }
    void setPermissionPreset(value);
  };

  return (
    <>
      <Select
        value={current}
        options={options}
        onValueChange={choose}
        className="h-7 px-2 text-xs"
        aria-label={`Access mode, current: ${labelOf(current)}`}
      />
      <Dialog open={pendingFullAccess} onOpenChange={setPendingFullAccess}>
        <DialogContent aria-describedby="full-access-description">
          <DialogHeader>
            <DialogTitle>Enable Full access?</DialogTitle>
            <DialogDescription id="full-access-description">
              Full access allows the agent to modify files and execute commands
              without the usual confirmation steps. Only enable it for tasks you
              trust.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingFullAccess(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setPendingFullAccess(false);
                void setPermissionPreset("danger-full-access");
              }}
            >
              Enable Full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

const ModelSelectorAction: FC = () => {
  const hostModel = useDsh((s) => s.host?.model);
  const modelCatalogGroups = useDsh((s) => s.modelCatalogGroups);
  const selectedProvider = useDsh((s) => s.selectedProvider);
  const selectedModel = useDsh((s) => s.selectedModel);
  const selectedReasoningEffort = useDsh((s) => s.selectedReasoningEffort);
  const modelRoutable = useDsh((s) => s.modelRoutable);
  const setModelSelection = useDsh((s) => s.setModelSelection);

  const groups = modelCatalogGroups.length
    ? modelCatalogGroups
    : hostModel
      ? [
          {
            id: "default",
            name: "Models",
            models: [{ id: hostModel, name: hostModel }],
          },
        ]
      : [];
  const catalogModels = groups.flatMap((group) =>
    group.models.map((model) => ({
      id: `${group.id}/${model.id}`,
      provider: group.id,
      model: model.id,
      group: group.name,
      name: model.name,
      description: model.description,
      defaultEffort: model.reasoning?.defaultEffort,
      efforts: model.reasoning?.efforts,
    })),
  );
  const currentProvider = selectedProvider ?? "";
  const currentModel = selectedModel ?? hostModel;
  const models =
    currentProvider &&
    currentModel &&
    !catalogModels.some(
      (model) =>
        model.provider === currentProvider && model.model === currentModel,
    )
      ? [
          ...catalogModels,
          {
            id: `${currentProvider}/${currentModel}`,
            provider: currentProvider,
            model: currentModel,
            group: "Unavailable",
            name: currentModel,
            description: "The selected model is currently unavailable",
            defaultEffort: undefined,
            efforts: undefined,
            disabled: true,
          },
        ]
      : catalogModels;
  if (!models.length) return null;

  const selected =
    models.find(
      (model) =>
        model.provider === selectedProvider &&
        model.model === (selectedModel ?? hostModel),
    ) ?? models[0];
  return (
    <ModelSelector
      models={models}
      value={selected.id}
      effort={selectedReasoningEffort}
      onValueChange={(value) => {
        const next = models.find((model) => model.id === value);
        if (next?.provider && next.model)
          void setModelSelection(next.provider, next.model, next.defaultEffort);
      }}
      onEffortChange={(effort) => {
        if (selected.provider && selected.model)
          void setModelSelection(selected.provider, selected.model, effort);
      }}
      variant="ghost"
      size="sm"
      searchable={models.length > 6}
      aria-label="Select model"
    />
  );
};

const ComposerContextAction: FC = () => {
  const usage = useDsh((s) => s.contextUsage);
  if (!usage) return null;
  return <ComposerContext usage={usage} />;
};


const ComposerAction: FC<{
  armed: boolean;
  onSteer: () => void;
  onCancel: () => void;
}> = ({ armed, onSteer, onCancel }) => {
  const modelRoutable = useDsh((s) => s.modelRoutable);
  const running = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  const primary = primaryActionOf({ running, isEmpty, armed });

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <ComposerAddAttachment />
        <PermissionSelectorAction />
      </div>
      <div className="flex items-center gap-1.5">
        <ModelSelectorAction />
        <ComposerContextAction />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        {primary === "send" && (
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              disabled={modelRoutable === false}
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        )}
        {primary === "steer" && (
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-steer size-7 rounded-full"
            aria-label="Send steering message"
            title="Send steering message (Enter)"
            onClick={onSteer}
          >
            <ArrowUpIcon className="aui-composer-steer-icon size-4.5" />
          </Button>
        )}
        {(primary === "stop" || primary === "esc") && (
          <Button
            type="button"
            variant="default"
            size="icon"
            className={cn(
              "size-7 rounded-full",
              primary === "esc" ? "aui-composer-esc" : "aui-composer-cancel",
            )}
            aria-label={
              primary === "esc" ? "Press Esc again to stop" : "Stop generating"
            }
            title={
              primary === "esc"
                ? "Press Esc again within 1s to stop"
                : "Stop generating"
            }
            onClick={onCancel}
          >
            {primary === "esc" ? (
              <span className="text-[10px] font-semibold tracking-wide">
                Esc
              </span>
            ) : (
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
};
