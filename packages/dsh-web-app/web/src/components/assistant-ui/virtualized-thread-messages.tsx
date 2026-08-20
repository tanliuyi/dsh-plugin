"use client";

import {
  ThreadPrimitive,
  useAuiState,
  type ThreadMessage,
} from "@assistant-ui/react";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";

import { useDsh } from "@/dsh/store";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";

import {
  mergeSelectedVirtualIndexes,
  shouldPrefetchOlderHistory,
  type ThreadMessageRow,
} from "./thread-virtualization";

const ESTIMATED_ASSISTANT_MESSAGE_HEIGHT = 2_400;
const ESTIMATED_OTHER_MESSAGE_HEIGHT = 240;
const HISTORY_LOADER_HEIGHT = 36;
const MESSAGE_GROUP_END_GAP = 56;
const ESTIMATED_SCROLL_PADDING_END = 182;
const AT_BOTTOM_THRESHOLD = 4;

interface MessageSelectionRange {
  start: number;
  end: number;
}

interface VirtualizedThreadMessagesProps {
  viewportRef: RefObject<HTMLDivElement | null>;
  messageComponent: ComponentType;
}

export function VirtualizedThreadMessages({
  viewportRef,
  messageComponent,
}: VirtualizedThreadMessagesProps) {
  const messageRows = useThreadMessageRows();
  const historyHasMore = useDsh((state) => state.historyHasMore);
  const loadingMoreHistory = useDsh((state) => state.loadingMoreHistory);
  const historyLoadError = useDsh((state) => state.historyLoadError);
  const loadMoreHistory = useDsh((state) => state.loadMoreHistory);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedToEndRef = useRef(true);
  const [scrollPaddingEnd, setScrollPaddingEnd] = useState(
    ESTIMATED_SCROLL_PADDING_END,
  );
  const [selectionRange, setSelectionRange] =
    useState<MessageSelectionRange | null>(null);
  const getItemKey = useCallback(
    (index: number) =>
      messageRows[index]?.virtualKey ?? messageRows[index]?.id ?? index,
    [messageRows],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const visibleIndexes = defaultRangeExtractor(range);
      const indexes = selectionRange
        ? mergeSelectedVirtualIndexes(
            visibleIndexes,
            selectionRange,
            range.count,
          )
        : visibleIndexes;
      if (!pinnedToEndRef.current || range.count === 0) return indexes;
      const pinnedIndexes = new Set(indexes);
      const pinnedStart = Math.max(0, range.count - 2);
      for (let index = pinnedStart; index < range.count; index += 1) {
        pinnedIndexes.add(index);
      }
      return [...pinnedIndexes].sort((left, right) => left - right);
    },
    [selectionRange],
  );
  // A history page can start mid-turn. Message keys stay stable when prepend
  // later merges that partial turn with its preceding user message.
  const virtualizer = useVirtualizer({
    count: messageRows.length,
    estimateSize: (index) =>
      index < messageRows.length - 1 &&
      messageRows[index]?.role === "assistant"
        ? ESTIMATED_ASSISTANT_MESSAGE_HEIGHT
        : ESTIMATED_OTHER_MESSAGE_HEIGHT,
    getItemKey,
    getScrollElement: () => viewportRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 20,
    paddingStart: HISTORY_LOADER_HEIGHT,
    rangeExtractor,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD,
    scrollPaddingEnd,
    useAnimationFrameWithResizeObserver: true,
    directDomUpdates: true,
    directDomUpdatesMode: "transform",
    // This list measures during React commits; nested react-dom flushSync warns.
    useFlushSync: false,
  });
  const setContentElement = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      virtualizer.containerRef(element);
    },
    [virtualizer],
  );

  useLayoutEffect(() => {
    const footer = viewportRef.current?.querySelector<HTMLElement>(
      ".aui-thread-viewport-footer",
    );
    if (!footer) return;
    const updateScrollPaddingEnd = () => {
      setScrollPaddingEnd(footer.offsetHeight + MESSAGE_GROUP_END_GAP);
    };
    const observer = new ResizeObserver(updateScrollPaddingEnd);
    observer.observe(footer);
    updateScrollPaddingEnd();
    return () => observer.disconnect();
  }, [viewportRef]);

  const measureVirtualRow = useCallback(
    (element: HTMLDivElement | null) => {
      virtualizer.measureElement(element);
      if (!element) return;
      const images = Array.from(element.querySelectorAll("img"));
      if (images.length === 0) return;
      void Promise.all(images.map((image) => image.decode().catch(() => undefined)))
        .then(() => {
          if (!element.isConnected) return;
          const index = Number(element.dataset.index);
          if (Number.isInteger(index)) {
            virtualizer.resizeItem(index, element.getBoundingClientRect().height);
            if (pinnedToEndRef.current) virtualizer.scrollToEnd();
          }
        });
    },
    [virtualizer],
  );

  const requestOlderHistory = useCallback(() => {
    if (loadingMoreHistory || !historyHasMore) return;
    void loadMoreHistory();
  }, [historyHasMore, loadMoreHistory, loadingMoreHistory]);

  const jumpToBottom = useCallback(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observedRows = new Set<HTMLDivElement>();
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLDivElement;
        const index = Number(row.dataset.index);
        if (Number.isInteger(index)) {
          virtualizer.resizeItem(index, row.getBoundingClientRect().height);
        }
      }
      if (pinnedToEndRef.current) virtualizer.scrollToEnd();
    });
    const syncObservedRows = () => {
      const mountedRows = new Set(
        content.querySelectorAll<HTMLDivElement>("[data-virtual-message-index]"),
      );
      for (const row of observedRows) {
        if (mountedRows.has(row)) continue;
        resizeObserver.unobserve(row);
        observedRows.delete(row);
      }
      for (const row of mountedRows) {
        if (observedRows.has(row)) continue;
        observedRows.add(row);
        resizeObserver.observe(row);
      }
    };
    const mutationObserver = new MutationObserver(syncObservedRows);
    syncObservedRows();
    mutationObserver.observe(content, { childList: true });
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [virtualizer]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onScroll = () => {
      pinnedToEndRef.current = virtualizer.isAtEnd();
      if (
        shouldPrefetchOlderHistory(element.scrollTop, element.clientHeight)
      ) {
        requestOlderHistory();
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [requestOlderHistory, viewportRef, virtualizer]);

  useEffect(() => {
    const updateSelectionRange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionRange(null);
        return;
      }
      const messageIndex = (node: Node | null): number | undefined => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>("[data-virtual-message-index]");
        if (!row || !contentRef.current?.contains(row)) return undefined;
        const index = Number(row.dataset.virtualMessageIndex);
        return Number.isInteger(index) ? index : undefined;
      };
      const anchor = messageIndex(selection.anchorNode);
      const focus = messageIndex(selection.focusNode);
      const startIndex = anchor ?? focus;
      const endIndex = focus ?? anchor;
      if (startIndex === undefined || endIndex === undefined) {
        setSelectionRange(null);
        return;
      }
      const start = Math.min(startIndex, endIndex);
      const end = Math.max(startIndex, endIndex);
      setSelectionRange((current) =>
        current?.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    document.addEventListener("selectionchange", updateSelectionRange);
    return () =>
      document.removeEventListener("selectionchange", updateSelectionRange);
  }, []);

  const didInitialJumpRef = useRef(false);

  useLayoutEffect(() => {
    if (didInitialJumpRef.current || messageRows.length === 0) return;
    didInitialJumpRef.current = true;
    jumpToBottom();
  }, [jumpToBottom, messageRows.length]);

  const items = virtualizer.getVirtualItems();
  const messageComponents = useMemo(
    () => ({ Message: messageComponent }),
    [messageComponent],
  );
  const showHistoryLoader =
    historyHasMore || loadingMoreHistory || historyLoadError !== null;

  return (
    <div
      ref={setContentElement}
      data-slot="aui_virtualized-message-list"
      className="relative [overflow-anchor:none]"
    >
      <div
        data-slot="aui_history-loader"
        className={`text-muted-foreground absolute inset-x-0 top-0 flex h-9 items-center justify-center gap-2 pb-3 text-xs ${showHistoryLoader ? "" : "invisible"}`}
        role={showHistoryLoader ? "status" : undefined}
        aria-hidden={showHistoryLoader ? undefined : true}
      >
        {loadingMoreHistory ? (
          <>
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            <span>Loading earlier messages</span>
          </>
        ) : historyLoadError ? (
          <button
            type="button"
            onClick={requestOlderHistory}
            className="hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
            title={historyLoadError}
          >
            <RotateCcwIcon className="size-3.5" />
            Retry loading earlier messages
          </button>
        ) : (
          <span>Scroll up to load earlier messages</span>
        )}
      </div>
      {items.map((item) => {
        const message = messageRows[item.index];
        if (!message) return null;
        return (
          <div
            key={item.key}
            ref={measureVirtualRow}
            data-index={item.index}
            data-virtual-message-id={message.id}
            data-virtual-message-index={item.index}
            data-slot="aui_thread-message"
            className={
              item.index === messageRows.length - 1
                ? "absolute left-0 top-0 w-full"
                : "absolute left-0 top-0 w-full pb-6"
            }
            onLoadCapture={(event) => {
              virtualizer.resizeItem(
                item.index,
                event.currentTarget.getBoundingClientRect().height,
              );
              if (pinnedToEndRef.current) virtualizer.scrollToEnd();
            }}
          >
            <ThreadPrimitive.Unstable_MessageById
              messageId={message.id}
              components={messageComponents}
            />
          </div>
        );
      })}
    </div>
  );
}

function useThreadMessageRows(): readonly ThreadMessageRow[] {
  const dshMessages = useDsh((state) => state.messages);
  const virtualKeyById = useMemo(
    () => new Map<string, string>(dshMessages.flatMap((message) =>
      message.virtualKey === undefined
        ? []
        : [[message.id, message.virtualKey] as const],
    )),
    [dshMessages],
  );
  const previousRowsRef = useRef<readonly ThreadMessageRow[]>([]);
  return useAuiState((state) => {
    const messages = state.thread.messages;
    const previous = previousRowsRef.current;
    if (
      previous.length === messages.length &&
      previous.every((row, index) => {
        const message = messages[index];
        return (
          message !== undefined &&
          row.id === message.id &&
          row.virtualKey === virtualKeyById.get(message.id) &&
          row.role === message.role
        );
      })
    ) {
      return previous;
    }
    const next = messages.map(({ id, role }: ThreadMessage) => {
      const virtualKey = virtualKeyById.get(id);
      return {
        id,
        role,
        ...(virtualKey === undefined ? {} : { virtualKey }),
      };
    });
    previousRowsRef.current = next;
    return next;
  });
}
