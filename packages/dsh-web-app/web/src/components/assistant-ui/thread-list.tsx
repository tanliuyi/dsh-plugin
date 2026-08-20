"use client";

import { deriveThreadListProjection } from "@/dsh/thread-list";
import { rpc } from "@/dsh/api";
import { useDsh } from "@/dsh/store";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { threadIdFromPathname, useThreadNavigation } from "@/router-navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  BotIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
} from "react";

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot>
      <div>
          <h1>DeepSeek</h1>
        </div>
      <div
        data-slot="aui_thread-list-toolbar"
        className="flex h-8 items-center justify-between px-2.5"
      >
        
        <h2 className="text-sm font-medium text-foreground">工作区</h2>
        <div
          data-slot="aui_thread-list-toolbar-actions"
          className="flex items-center gap-0.5"
        >
          <TooltipIconButton
            tooltip="Search threads"
            type="button"
            data-slot="aui_thread-list-search-toggle"
            aria-label="Search threads"
            aria-pressed={searchOpen}
            className="size-7 text-muted-foreground"
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setSearch("");
            }}
          >
            <SearchIcon className="size-4" />
          </TooltipIconButton>
          <ThreadListViewControls />
          <TooltipIconButton
            tooltip="Add workspace"
            type="button"
            data-slot="aui_thread-list-add-workspace"
            aria-label="Add workspace"
            className="size-7 text-muted-foreground"
            onClick={() => void useDsh.getState().addWorkspace()}
          >
            <PlusIcon className="size-4" />
          </TooltipIconButton>
        </div>
      </div>
      {searchOpen && hasThreads && (
        <ThreadListSearch value={search} onValueChange={setSearch} />
      )}
      <ThreadListItems searchQuery={searchOpen && hasThreads ? search : ""} />
    </ThreadListRoot>
  );
};

const ThreadListViewControls: FC = () => {
  const [open, setOpen] = useState(false);
  const groupBy = useDsh((s) => s.threadListView.groupBy);
  const orderBy = useDsh((s) => s.threadListView.orderBy);
  const setGroupBy = useDsh((s) => s.setThreadListGroupBy);
  const setOrderBy = useDsh((s) => s.setThreadListOrderBy);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          tooltip="Thread list filters"
          type="button"
          data-slot="aui_thread-list-filter-toggle"
          aria-label="Thread list filters"
          className="size-7 text-muted-foreground"
        >
          <SlidersHorizontalIcon className="size-4" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>分组方式</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={groupBy}
          onValueChange={(value) => setGroupBy(value as typeof groupBy)}
        >
          <DropdownMenuRadioItem value="workspace">
            按工作区
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="flat">列表</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>排序方式</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={orderBy}
          onValueChange={(value) => setOrderBy(value as typeof orderBy)}
        >
          <DropdownMenuRadioItem value="manual">手动排序</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="updated">
            最近更新
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="Search threads"
        placeholder="Search threads"
        className={cn("h-8 ps-8 text-sm", className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex min-h-0 flex-1 flex-col gap-0.5 px-2", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain -me-2 pe-2",
        className,
      )}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

const INITIAL_THREAD_COUNT = 5;
const THREAD_COUNT_INCREMENT = 10;

type ThreadTreeItemContextValue = {
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  toggleExpanded?: () => void;
};

const ThreadTreeItemContext = createContext<ThreadTreeItemContextValue>({
  depth: 0,
  hasChildren: false,
  expanded: false,
});

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const sessions = useDsh((s) => s.sessions);
  const workspaces = useDsh((s) => s.workspaces);
  const archivedSessionIds = useDsh((s) => s.archivedSessionIds);
  const view = useDsh((s) => s.threadListView);
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const setGroupExpanded = useDsh((s) => s.setThreadListGroupExpanded);
  const setNewSessionWorkspace = useDsh((s) => s.setNewSessionWorkspace);
  const loadSubagents = useDsh((s) => s.loadSubagents);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const query = searchQuery.trim().toLowerCase();
  const navigateToThread = useThreadNavigation();
  const [remoteResults, setRemoteResults] = useState<
    Array<{ sessionId: string; snippet: string }>
  >([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [visibleThreadCounts, setVisibleThreadCounts] = useState<
    Record<string, number>
  >({});
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const expandThreads = (groupKey: string) => {
    setVisibleThreadCounts((current) => ({
      ...current,
      [groupKey]:
        (current[groupKey] ?? INITIAL_THREAD_COUNT) + THREAD_COUNT_INCREMENT,
    }));
  };
  const collapseThreads = (groupKey: string) => {
    setVisibleThreadCounts((current) => ({
      ...current,
      [groupKey]: INITIAL_THREAD_COUNT,
    }));
  };

  useEffect(() => {
    if (query.length < 2) {
      setRemoteResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setRemoteLoading(true);
      void rpc<{
        items: Array<{ sessionId: string; snippet: string }>;
        hasMore: boolean;
      }>("session.search", { query })
        .then((result) => {
          if (!cancelled) setRemoteResults(result.ok ? result.value.items : []);
        })
        .catch(() => {
          if (!cancelled) setRemoteResults([]);
        })
        .finally(() => {
          if (!cancelled) setRemoteLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const projection = useMemo(
    () =>
      deriveThreadListProjection(
        sessions,
        workspaces,
        archivedSessionIds,
        view,
      ),
    [sessions, workspaces, archivedSessionIds, view],
  );
  const indexById = useMemo(
    () => new Map(threadIds.map((id, index) => [id, index])),
    [threadIds],
  );
  const labelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const group of projection.groups) {
      for (const id of group.sessionIds) labels.set(id, group.label);
    }
    return labels;
  }, [projection.groups]);
  const filteredIds = useMemo(() => {
    if (!query) return projection.sessions.map((session) => session.sessionId);
    return projection.sessions
      .filter((session) => {
        const title = session.title || "New Chat";
        return (
          title.toLowerCase().includes(query) ||
          labelById.get(session.sessionId)?.toLowerCase().includes(query)
        );
      })
      .map((session) => session.sessionId);
  }, [projection.sessions, query, labelById]);

  useEffect(() => {
    const routeSessionId = typeof window === "undefined"
      ? null
      : threadIdFromPathname(window.location.pathname);
    const activeSessionId = routeSessionId ?? currentSessionId;
    if (view.groupBy !== "workspace" || activeSessionId === null) return;
    const parentByChild = new Map<string, string>();
    for (const [parentId, childIds] of Object.entries(projection.childrenByParent)) {
      for (const childId of childIds) parentByChild.set(childId, parentId);
    }
    let rootId = activeSessionId;
    const seen = new Set<string>();
    while (parentByChild.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId);
      rootId = parentByChild.get(rootId)!;
    }
    const group = projection.groups.find((item) =>
      item.sessionIds.includes(rootId),
    );
    if (group && !view.expandedGroups.includes(group.key)) {
      setGroupExpanded(group.key, true);
    }
  }, [
    currentSessionId,
    projection.childrenByParent,
    projection.groups,
    setGroupExpanded,
    view.expandedGroups,
    view.groupBy,
  ]);

  useEffect(() => {
    const routeSessionId = typeof window === "undefined"
      ? null
      : threadIdFromPathname(window.location.pathname);
    const activeSessionId = routeSessionId ?? currentSessionId;
    if (activeSessionId === null) return;
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let current = byId.get(activeSessionId);
    while (
      current?.origin === "subagent" &&
      current.parentSessionId &&
      !seen.has(current.sessionId)
    ) {
      seen.add(current.sessionId);
      ancestors.push(current.parentSessionId);
      current = byId.get(current.parentSessionId);
    }
    if (ancestors.length === 0) return;
    for (const parentId of ancestors) void loadSubagents(parentId).catch(() => {});
    setExpandedSessionIds((expanded) => {
      if (ancestors.every((id) => expanded.has(id))) return expanded;
      return new Set([...expanded, ...ancestors]);
    });
  }, [currentSessionId, loadSubagents, sessions]);

  const renderItem = (
    id: string,
    tree: Omit<ThreadTreeItemContextValue, "toggleExpanded"> & {
      toggleExpanded?: () => void;
    } = { depth: 0, hasChildren: false, expanded: false },
  ) => {
    const index = indexById.get(id);
    if (index === undefined) return null;
    return (
      <ThreadTreeItemContext.Provider key={id} value={tree}>
        <ThreadListPrimitive.ItemByIndex
          index={index}
          components={{ ThreadListItem }}
        />
      </ThreadTreeItemContext.Provider>
    );
  };

  const renderTreeItem = (id: string, depth = 0): ReactNode => {
    const children = projection.childrenByParent[id] ?? [];
    const expanded = expandedSessionIds.has(id);
    const item = renderItem(id, {
      depth,
      hasChildren: children.length > 0,
      expanded,
      toggleExpanded: children.length > 0
        ? () => setExpandedSessionIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else {
              next.add(id);
              void loadSubagents(id).catch(() => {});
            }
            return next;
          })
        : undefined,
    });
    return (
      <div key={id} data-slot="aui_thread-tree-node">
        {item}
        {children.length > 0 && expanded ? (
          <div role="group" data-slot="aui_thread-tree-children" className="ms-4">
            {children.map((childId) => (
              <div
                key={childId}
                className="relative ps-5 before:absolute before:start-0 before:top-0 before:h-full before:border-s before:border-border/80 after:absolute after:start-0 after:top-4 after:w-4 after:border-t after:border-border/80 last:before:h-4"
              >
                {renderTreeItem(childId, depth + 1)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  if (query) {
    const remoteOnly = remoteResults.filter(
      (result) => !filteredIds.includes(result.sessionId),
    );
    if (filteredIds.length === 0 && remoteOnly.length === 0) {
      return (
        <div
          data-slot="aui_thread-list-empty"
          className="text-muted-foreground px-2.5 py-4 text-sm"
        >
          {remoteLoading ? "Searching sessions…" : "No threads found"}
        </div>
      );
    }
    return (
      <div className="grid gap-1">
        {remoteOnly.map((result) => (
          <button
            key={result.sessionId}
            type="button"
            className="flex min-w-0 flex-col items-start rounded-md px-2.5 py-2 text-start hover:bg-muted"
            onClick={() => void navigateToThread(result.sessionId)}
          >
            <span className="w-full truncate text-sm text-foreground">
              {result.snippet || result.sessionId}
            </span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {result.sessionId}
            </span>
          </button>
        ))}
        {filteredIds.map((id) => renderItem(id))}
      </div>
    );
  }

  if (view.groupBy === "flat") {
    const childIds = new Set(Object.values(projection.childrenByParent).flat());
    return <>{filteredIds.filter((id) => !childIds.has(id)).map((id) => renderTreeItem(id))}</>;
  }

  return (
    <>
      {projection.groups.map((group) => {
        const visibleThreadCount =
          visibleThreadCounts[group.key] ?? INITIAL_THREAD_COUNT;
        const visibleSessionIds = group.sessionIds.slice(0, visibleThreadCount);
        const hasMoreThreads =
          visibleSessionIds.length < group.sessionIds.length;
        const hasExpandedThreads = visibleThreadCount > INITIAL_THREAD_COUNT;

        return (
          <div
            key={group.key || "ungrouped"}
            data-slot="aui_thread-list-group"
            className="group/workspace"
          >
            <div
              data-slot="aui_thread-list-group-trigger"
              role="button"
              tabIndex={0}
              aria-expanded={group.expanded}
              title={group.path}
              onClick={() => setGroupExpanded(group.key, !group.expanded)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setGroupExpanded(group.key, !group.expanded);
                }
              }}
              className="text-muted-foreground flex min-h-8 w-full cursor-default items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {!group.expanded ? (
                <FolderIcon className="size-4 shrink-0" />
              ) : (
                <FolderOpenIcon className="size-4 shrink-0" />
              )}
              <span className="min-w-0 text-sm truncate">{group.label}</span>
              <div
                data-slot="aui_thread-list-group-actions"
                className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/workspace:opacity-100"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <WorkspaceGroupMore
                  workspaceId={group.workspaceId}
                  path={group.path ?? group.label}
                />
                <ThreadListNew
                  aria-label={`New thread in ${group.label}`}
                  tooltip={`New thread in ${group.label}`}
                  className="size-6 justify-center rounded-md p-0 text-muted-foreground"
                  onClick={() => {
                    if (group.workspaceId)
                      setNewSessionWorkspace(group.workspaceId);
                  }}
                >
                  <PlusIcon className="size-3.5" />
                </ThreadListNew>
              </div>
            </div>
            {group.expanded &&
              (group.sessionIds.length > 0 ? (
                <>
                  {visibleSessionIds.map((id) => renderTreeItem(id))}
                  {(hasMoreThreads || hasExpandedThreads) && (
                    <div className="flex items-center gap-3 ps-6 pe-2.5 py-1">
                      {hasMoreThreads && (
                        <button
                          type="button"
                          data-slot="aui_thread-list-expand-more"
                          className="text-muted-foreground hover:text-foreground cursor-pointer px-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          onClick={() => expandThreads(group.key)}
                        >
                          展开更多
                        </button>
                      )}
                      {hasExpandedThreads && (
                        <button
                          type="button"
                          data-slot="aui_thread-list-collapse"
                          className="text-muted-foreground hover:text-foreground cursor-pointer px-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          onClick={() => collapseThreads(group.key)}
                        >
                          收起
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div
                  data-slot="aui_thread-list-group-empty"
                  className="text-muted-foreground px-2.5 py-2 text-xs"
                >
                  没有会话
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
};

const copyWorkspacePath = async (path: string): Promise<void> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
      return;
    }
  } catch {
    // Clipboard permissions may be unavailable in a proxied local page.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = path;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  } catch {
    // Copy is best effort; never surface a rejected clipboard promise.
  }
};

const WorkspaceGroupMore: FC<{ workspaceId?: string; path: string }> = ({
  workspaceId,
  path,
}) => {
  const [open, setOpen] = useState(false);
  const renameWorkspace = useDsh((state) => state.renameWorkspace);
  const deleteWorkspace = useDsh((state) => state.deleteWorkspace);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          tooltip="Workspace actions"
          type="button"
          aria-label="Workspace actions"
          className="size-6 rounded-md p-0 text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onSelect={() => {
            void copyWorkspacePath(path);
          }}
        >
          复制工作区路径
        </DropdownMenuItem>
        {workspaceId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const title = window.prompt(
                  "重命名工作区",
                  path
                    .split(/[\\\\/]/)
                    .filter(Boolean)
                    .pop() ?? "",
                );
                if (title?.trim())
                  void renameWorkspace(workspaceId, title).catch(() => {});
              }}
            >
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                if (window.confirm("移除工作区注册不会删除目录或会话。继续？"))
                  void deleteWorkspace(workspaceId).catch(() => {});
              }}
            >
              移除工作区
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & {
    labelClassName?: string;
    tooltip?: string;
  }
>(({ className, labelClassName, tooltip, children, ...props }, ref) => {
  const content = children ?? (
    <>
      <PlusIcon
        data-slot="aui_thread-list-new-icon"
        className="size-4 shrink-0"
      />
      <span
        data-slot="aui_thread-list-new-label"
        className={cn("whitespace-nowrap", labelClassName)}
      >
        New Thread
      </span>
    </>
  );

  return (
    <ThreadListPrimitive.New asChild>
      {tooltip ? (
        <TooltipIconButton
          ref={ref}
          tooltip={tooltip}
          data-slot="aui_thread-list-new"
          className={cn(
            "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
            className,
          )}
          {...props}
        >
          {content}
        </TooltipIconButton>
      ) : (
        <Button
          ref={ref}
          variant="ghost"
          data-slot="aui_thread-list-new"
          className={cn(
            "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
            className,
          )}
          {...props}
        >
          {content}
        </Button>
      )}
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="Loading threads"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  delegate: "委派",
  worker: "执行者",
  reviewer: "审查员",
  scout: "侦察员",
  researcher: "研究员",
  oracle: "顾问",
};

function subagentRoleLabel(label?: string): string {
  const role = label?.split("·", 1)[0]?.trim().toLowerCase();
  return role ? (SUBAGENT_ROLE_LABELS[role] ?? "子代理") : "子代理";
}

function subagentTaskTitle(label: string | undefined, fallback: string): string {
  if (!label?.trim()) return fallback;
  const [role, ...task] = label.split("·");
  if (task.length > 0 && SUBAGENT_ROLE_LABELS[role.trim().toLowerCase()]) {
    return task.join("·").trim() || fallback;
  }
  return label.trim();
}

export const ThreadListItem: FC = () => {
  const isPendingRequest = useAuiState(
    (s) => s.threadListItem.custom?.hasPendingRequest === true,
  );
  const isRunning = useAuiState(
    (s) => s.threadListItem.custom?.running === true,
  );
  const threadId = useAuiState((s) => s.threadListItem.id);
  const currentSessionId = useDsh((s) => s.currentSessionId);
  const session = useDsh((s) =>
    s.sessions.find((item) => item.sessionId === threadId),
  );
  const tree = useContext(ThreadTreeItemContext);
  const isSubagent = session?.origin === "subagent" && tree.depth > 0;
  const isActive = currentSessionId === threadId;
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 min-w-0 items-center rounded-md transition-colors focus-visible:outline-none",
        !tree.hasChildren && !isSubagent && "ps-4",
      )}
    >
      {tree.hasChildren ? (
        <button
          type="button"
          data-slot="aui_thread-tree-toggle"
          aria-label={(tree.expanded ? "Collapse " : "Expand ") + (session?.title ?? "thread") + " subagents"}
          aria-expanded={tree.expanded}
          className="absolute start-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center rounded-full bg-background text-muted-foreground shadow-xs ring-1 ring-border/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={(event) => {
            event.stopPropagation();
            tree.toggleExpanded?.();
          }}
        >
          {tree.expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
      ) : null}
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          className={cn(
            "focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-start text-sm outline-none focus-visible:ring-[3px]",
            isSubagent ? "px-2" : tree.hasChildren ? "ps-7 pe-3" : "px-3",
          )}
          title={session?.title}
        >
          {isSubagent ? (
            <>
              <BotIcon
                aria-hidden
                data-slot="aui_thread-list-item-subagent-icon"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span
                data-slot="aui_thread-list-item-subagent-role"
                className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
              >
                {subagentRoleLabel(session?.subagentLabel)}
              </span>
            </>
          ) : null}
          <span
            data-slot="aui_thread-list-item-title"
            className="min-w-0 flex-1 truncate"
          >
            {isSubagent
              ? subagentTaskTitle(session?.subagentLabel, session?.title ?? "Subagent")
              : <ThreadListItemPrimitive.Title fallback="New Chat" />}
          </span>
          {isPendingRequest ? (
            <CircleAlertIcon
              aria-hidden
              data-slot="aui_thread-list-item-pending-request"
              className={cn(
                "size-3.5 shrink-0 text-warning",
                !isSubagent && "group-hover:hidden group-has-focus-visible:hidden group-has-data-[state=open]:hidden",
              )}
            />
          ) : isRunning ? (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className={cn(
                "size-3.5 shrink-0 animate-spin text-muted-foreground",
                !isSubagent && "group-hover:hidden group-has-focus-visible:hidden group-has-data-[state=open]:hidden",
              )}
            />
          ) : null}
          {isPendingRequest ? (
            <span className="sr-only">Request needs attention</span>
          ) : isRunning ? (
            <span className="sr-only">Running</span>
          ) : null}
        </ThreadListItemPrimitive.Trigger>
      )}
      {!isSubagent ? (
        <ThreadListItemMore
          onRename={() => setIsRenaming(true)}
          isActive={isActive}
        />
      ) : null}
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label="Rename thread"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const ThreadListItemMore: FC<{ onRename: () => void; isActive: boolean }> = ({
  onRename,
  isActive,
}) => {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <TooltipIconButton
          tooltip="More options"
          data-slot="aui_thread-list-item-more"
          className={cn(
            "data-[state=open]:bg-accent hidden size-6 shrink-0 p-0 transition-none group-hover:flex group-has-focus-visible:flex data-[state=open]:flex",
          )}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </TooltipIconButton>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          Rename
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <ArchiveIcon className="size-4" />
            Archive
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <TrashIcon className="size-4" />
            Delete
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
