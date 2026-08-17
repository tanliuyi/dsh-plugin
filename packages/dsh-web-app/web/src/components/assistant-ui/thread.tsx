"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { File } from "@/components/assistant-ui/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/follow-up-suggestions";
import { Image } from "@/components/assistant-ui/image";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApprovalCard } from "@/components/approval-card";
import { ElicitationForm, type ElicitationField } from "@/components/elicitation-form";
import { MessageQueue } from "@/components/message-queue";
import { ComposerTriggerPopover } from "@/components/composer-trigger-popover";
import { ComposerContext } from "@/components/composer";
import { ModelSelector } from "@/components/model-selector";
import {
  Select,
  type SelectOption,
} from "@/components/select";
import { useDsh } from "@/dsh/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  unstable_defaultDirectiveFormatter,
  unstable_useSlashCommandAdapter,
  type AssistantState,
  type Unstable_DirectiveFormatter,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  TerminalIcon,
  RefreshCwIcon,
  SquareIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS }) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

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
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-2 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            <JobStatusBar />
            <PendingInteractionCards />
            <QueueDock />
            <GoalBar />
            <Composer />
            <AuiIf condition={(s) => isNewChatView(s)}>
              <div data-slot="aui_thread-suggestions-spacer" className="min-h-8">
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

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const GoalBar: FC = () => {
  const goal = useDsh((s) => s.goal);
  const pause = useDsh((s) => s.pauseGoal);
  const resume = useDsh((s) => s.resumeGoal);
  const complete = useDsh((s) => s.completeGoal);
  const clear = useDsh((s) => s.clearGoal);
  const edit = useDsh((s) => s.editGoal);
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  if (!goal) return null;
  const isPaused = goal.goal.phase === "paused";
  const isComplete = goal.goal.phase === "complete";
  return (
    <div data-slot="aui_goal_bar" className="bg-muted/30 flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
      <span aria-hidden className="text-foreground/70">Goal</span>
      {editing ? (
        <>
          <Input
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={goal.goal.objective}
            className="h-7 min-w-0 flex-1 text-xs"
            aria-label="Goal objective"
          />
          <Button size="sm" variant="ghost" onClick={() => { void edit(objective || undefined); setEditing(false); }}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate" title={goal.goal.objective}>{goal.goal.objective}</span>
      )}
      {!editing ? <span className="text-muted-foreground shrink-0">{goal.goal.phase} · {goal.roundsStarted}/{goal.goal.maxGoalRounds}</span> : null}
      {!editing && !isComplete ? <Button size="sm" variant="ghost" onClick={() => { setObjective(goal.goal.objective); setEditing(true); }}>Edit</Button> : null}
      {!editing && !isComplete ? <Button size="sm" variant="ghost" onClick={() => void (isPaused ? resume() : pause())}>{isPaused ? "Resume" : "Pause"}</Button> : null}
      {!editing && !isComplete ? <Button size="sm" variant="ghost" onClick={() => void complete()}>Complete</Button> : null}
      {!editing ? <Button size="sm" variant="ghost" onClick={() => void clear()}>Clear</Button> : null}
    </div>
  );
};

const JobStatusBar: FC = () => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const jobsBySession = useDsh((s) => s.jobsBySession);
  const sessions = useDsh((s) => s.sessions);
  const jobs = currentSessionId ? jobsBySession[currentSessionId] ?? [] : [];
  const subagentCount = useMemo(
    () => currentSessionId
      ? sessions.filter((session) => session.parentSessionId === currentSessionId || (session.origin === "subagent" && session.parentSessionId === currentSessionId)).length
      : 0,
    [currentSessionId, sessions],
  );
  if (jobs.length === 0 && subagentCount === 0) return null;
  return (
    <div
      data-slot="aui_thread-job-status"
      className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
      role="status"
    >
      {jobs.map((job) => (
        <span
          key={job.id}
          data-slot="aui_thread-job"
          data-status={job.status}
          className="bg-muted/60 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", job.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
          <span className="max-w-56 truncate">{job.label}</span>
          {job.detail ? <span className="text-muted-foreground/70">{job.detail}</span> : null}
        </span>
      ))}
      {subagentCount > 0 ? (
        <span data-slot="aui_thread-subagent-count" className="bg-muted/60 rounded-full px-2.5 py-1">
          {subagentCount} subagent{subagentCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
};

const PendingInteractionCards: FC = () => {
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const pendingInteractions = useDsh((s) => s.pendingInteractions);
  const pending = useMemo(
    () => pendingInteractions.filter((item) => item.sessionId === currentSessionId),
    [currentSessionId, pendingInteractions],
  );
  const respond = useDsh((s) => s.respondToInteraction);

  // 无待处理交互时不渲染，避免空容器占位。
  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-3">
      {pending.map((item) => {
        if (item.kind === "question") {
          return <QuestionInteraction key={item.rpcId} interaction={{ rpcId: item.rpcId, sessionId: item.sessionId, payload: item.payload as { questions: unknown[] } }} onRespond={respond} />;
        }
        const approval = item.payload as { approvalId: string; toolName: string; reason?: string };
        const answer = (outcome: "allowed-once" | "rejected") =>
          void respond(item.rpcId, { ok: true, value: { sessionId: item.sessionId, approvalId: approval.approvalId, outcome } });
        return (
          <ApprovalCard
            key={item.rpcId}
            state="request"
            command={approval.toolName}
            title="Permission required"
            subtitle={approval.reason ?? "This action needs your approval"}
            onAllowOnce={() => answer("allowed-once")}
            onDeny={() => answer("rejected")}
          />
        );
      })}
    </div>
  );
};

const QuestionInteraction: FC<{
  interaction: { rpcId: string; sessionId: string; payload: { questions: unknown[] } };
  onRespond: (rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }) => Promise<void>;
}> = ({ interaction, onRespond }) => {
  type Question = { id: string; header?: string; question: string; detail?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean };
  type Draft = { selected: string[]; custom: string };
  const questions = interaction.payload.questions as Question[];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const fields: ElicitationField[] = questions.map((question) => {
    const draft = drafts[question.id] ?? { selected: [], custom: "" };
    return {
      name: question.id,
      label: question.header ?? question.question,
      value: draft.custom || draft.selected.join(", "),
      selected: draft.selected,
      kind: question.options?.length ? "choice" : "text",
      options: question.options?.map((option) => option.label),
      required: true,
    };
  });
  const update = (name: string, value: string) => {
    const question = questions.find((item) => item.id === name);
    if (!question) return;
    setDrafts((current) => {
      const previous = current[name] ?? { selected: [], custom: "" };
      if (!question.options?.length) return { ...current, [name]: { selected: [], custom: value } };
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
              selected: draft.custom && !question.multiSelect ? [] : draft.selected,
              ...(draft.custom ? { custom: draft.custom } : {}),
            };
          }),
        },
      },
    });
  };
  return (
    <ElicitationForm
      server="Agent"
      message={questions.map((question) => question.question).join(" ")}
      fields={fields}
      state="request"
      onFieldChange={update}
      onAccept={answer}
      onDecline={() => void onRespond(interaction.rpcId, {
        ok: false,
        error: { code: "cancelled", message: "the user closed this question request", details: {} },
      })}
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
  const fallbackWorkspace = hostCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (!workspaceOptions.length && fallbackWorkspace) {
    workspaceOptions.push({ value: "__host__", label: fallbackWorkspace });
  }
  const presetOptions: SelectOption[] = presets.filter((preset) => !preset.broken).map((preset) => ({
    value: preset.id,
    label: (
      <span className="flex max-w-64 flex-col items-start text-left">
        <span>{preset.name ?? preset.id}</span>
        {preset.description && <span className="text-muted-foreground line-clamp-2 text-xs">{preset.description}</span>}
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
            onValueChange={(value) => setWorkspace(value === "__host__" ? "" : value)}
            options={workspaceOptions}
            className="h-7 max-w-48 items-center px-2 py-1 text-xs"
            placeholder="Workspace"
          />
        )}
        {presetOptions.length > 0 && (
          <Select
            value={agentPreset ?? presetOptions[0]!.value}
            onValueChange={(value) => void setAgentPreset(value).catch(() => {})}
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
  const slash = useSlashCommands();

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
            rows={1}
            autoFocus
            enterKeyHint="send"
            aria-label="Message input"
          />
          <ComposerAction />
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
  const executeCommand = useDsh((s) => s.executeCommand);
  const dynamicCommands = useDsh((s) => s.commands);
  const commands = useMemo(() => {
    const source = dynamicCommands.length > 0
      ? dynamicCommands
      : [
          { name: "compact", description: "压缩当前会话上下文" },
          { name: "goal", description: "输入目标，智能体将持续执行" },
          { name: "permission", description: "选择权限模式" },
          { name: "plan", description: "输入计划内容" },
        ];
    return source.map((command) => ({
      id: command.name,
      label: `/${command.name}`,
      description: command.description ?? "",
      execute: () => {
        if (command.name === "compact") void executeCommand(`/compact`);
      },
    }));
  }, [dynamicCommands, executeCommand]);
  const slash = unstable_useSlashCommandAdapter({ commands });
  return {
    adapter: slash.adapter,
    directive: { formatter: slashDirectiveFormatter },
  };
};

const slashDirectiveFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    const hints: Record<string, string> = {
      goal: "输入目标，智能体将持续执行",
      permission: "选择权限模式",
      plan: "输入计划内容",
    };
    const hint = hints[item.id];
    return hint ? `${item.label} ${hint}` : item.label;
  },
  parse: unstable_defaultDirectiveFormatter.parse,
};

const permissionShieldOutline = "M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z";

const PermissionGlyph: FC<{ value: string }> = ({ value }) => {
  if (value === "workspace-write") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87675 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959C8.01261 0.268728 8.05076 0.258321 8.08887 0.251709Z" fill="currentColor" />
        <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
        <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
        <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.414 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
        <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={permissionShieldOutline} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
      {value === "danger-full-access" ? (
        <>
          <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
          <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
        </>
      ) : (
        <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
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
    return value.replace(/(^|-)([a-z])/g, (_, _dash, letter) => ` ${letter.toUpperCase()}`).trim();
  };
  const iconOf = (value: string) => <PermissionGlyph value={value} />;
  const options: SelectOption[] = permissions.options.map((option) => ({
    value: option.value,
    label: <span className="flex items-center gap-2">{iconOf(option.value)}{labelOf(option.value)}</span>,
    triggerLabel: <span className="flex items-center gap-1.5">{iconOf(option.value)}{labelOf(option.value)}</span>,
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
              Full access allows the agent to modify files and execute commands without the usual confirmation steps. Only enable it for tasks you trust.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingFullAccess(false)}>Cancel</Button>
            <Button onClick={() => { setPendingFullAccess(false); void setPermissionPreset("danger-full-access"); }}>
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
  const selectedModel = useDsh((s) => s.selectedModel);
  const selectedReasoningEffort = useDsh((s) => s.selectedReasoningEffort);
  const setModelSelection = useDsh((s) => s.setModelSelection);

  const groups = modelCatalogGroups.length
    ? modelCatalogGroups
    : hostModel
      ? [{ id: "default", name: "Models", models: [{ id: hostModel, name: hostModel }] }]
      : [];
  const models = groups.flatMap((group) => group.models.map((model) => ({
    id: `${group.id}/${model.id}`,
    group: group.name,
    name: model.name,
    description: model.description,
    efforts: model.reasoning?.efforts,
  })));
  if (!models.length) return null;

  const selected = models.find((model) => model.id.endsWith(`/${selectedModel ?? hostModel}`)) ?? models[0];
  const modelId = selected.id.split("/").slice(1).join("/");
  return (
    <ModelSelector
      models={models}
      value={selected.id}
      effort={selectedReasoningEffort}
      onValueChange={(value) => {
        const next = models.find((model) => model.id === value);
        if (next) void setModelSelection(next.id.split("/").slice(1).join("/"));
      }}
      onEffortChange={(effort) => void setModelSelection(modelId, effort)}
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

const PlanModeAction: FC = () => {
  const active = useDsh((s) => s.planMode);
  const executeCommand = useDsh((s) => s.executeCommand);
  return (
    <button
      type="button"
      className={cn("h-7 rounded-full border px-2.5 text-xs transition-colors", active ? "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "text-muted-foreground hover:bg-muted")}
      aria-pressed={active}
      title={active ? "Disable plan mode" : "Enable plan mode"}
      onClick={() => void executeCommand(active ? "/plan off" : "/plan")}
    >
      Plan
    </button>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <ComposerAddAttachment />
        <PermissionSelectorAction />
        <PlanModeAction />
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
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
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
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

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
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot variant="ghost" streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                // dsh 上下文注入（runtime context / skill 目录等）：模型可见、用户弱化，
                // 折叠为一行小字（官方 ContextMessageNode 语义）。
                if (part.name === "dsh-context") {
                  const ctx = (part as { data?: { label?: string; text?: string } }).data ?? {};
                  return (
                    <div
                      data-slot="aui_context-injection"
                      className="text-muted-foreground/70 border-border/40 my-0.5 rounded border-l-2 border-dashed px-2 py-0.5 text-xs leading-relaxed"
                      title={ctx.text}
                    >
                      <span className="font-medium">📎 {ctx.label ?? "context"}</span>
                      <span className="ms-1.5 line-clamp-1">{ctx.text ?? ""}</span>
                    </div>
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
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessageImages: FC = () => {
  const content = useAuiState((s) => s.message.content);
  const images = content.filter((part) => part.type === "image");
  if (images.length === 0) return null;
  return (
    <div
      data-slot="aui_user-message-images"
      className="aui-user-message-images col-start-2 flex flex-wrap justify-end gap-2"
    >
      {images.map((part, index) => (
        <UserImagePart
          key={`${part.image}-${index}`}
          {...part}
          status={{ type: "complete" }}
        />
      ))}
    </div>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageImages />
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: () => null }}
          />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
