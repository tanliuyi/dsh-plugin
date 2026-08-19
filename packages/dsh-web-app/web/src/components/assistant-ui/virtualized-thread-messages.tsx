"use client";

import {
  ThreadPrimitive,
  useAuiState,
  type ThreadMessage,
} from "@assistant-ui/react";
import {
  defaultRangeExtractor,
  elementScroll,
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
  buildThreadTurns,
  mergeSelectedVirtualIndexes,
  stabilizeThreadTurnIds,
  type ThreadMessageRow,
  type ThreadTurn,
} from "./thread-virtualization";

const ESTIMATED_TURN_HEIGHT = 200;
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
  const turns = useThreadTurns(messageRows);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const historyHasMore = useDsh((state) => state.historyHasMore);
  const loadingMoreHistory = useDsh((state) => state.loadingMoreHistory);
  const historyLoadError = useDsh((state) => state.historyLoadError);
  const loadMoreHistory = useDsh((state) => state.loadMoreHistory);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const loadingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [selectionRange, setSelectionRange] =
    useState<MessageSelectionRange | null>(null);
  const getItemKey = useCallback(
    (index: number) => turns[index]?.id ?? index,
    [turns],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      return selectionRange
        ? mergeSelectedVirtualIndexes(indexes, selectionRange, range.count)
        : indexes;
    },
    [selectionRange],
  );
  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey,
    getScrollElement: () => viewportRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 6,
    rangeExtractor,
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement;
      if (!element) return;
      if (stickyRef.current) {
        const maxScroll = element.scrollHeight - element.clientHeight;
        const targetOffset = offset + (options.adjustments ?? 0);
        if (
          maxScroll - element.scrollTop <= AT_BOTTOM_THRESHOLD &&
          targetOffset < maxScroll
        ) {
          return;
        }
      }
      elementScroll(offset, options, instance);
    },
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => {
    const element = instance.elementsCache.get(item.key);
    const scrollElement = instance.scrollElement;
    if (!element || !scrollElement) {
      return item.end <= (instance.scrollOffset ?? 0);
    }
    return (
      element.getBoundingClientRect().bottom <=
      scrollElement.getBoundingClientRect().top
    );
  };

  const requestOlderHistory = useCallback(() => {
    const element = viewportRef.current;
    if (!element || loadingMoreHistory || !historyHasMore) return;
    stickyRef.current = false;
    loadingAnchorRef.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
    void loadMoreHistory();
  }, [historyHasMore, loadMoreHistory, loadingMoreHistory, viewportRef]);

  useLayoutEffect(() => {
    if (loadingMoreHistory || !loadingAnchorRef.current) return;
    const anchor = loadingAnchorRef.current;
    loadingAnchorRef.current = null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const element = viewportRef.current;
        if (!element) return;
        element.scrollTop = anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
      });
    });
  }, [loadingMoreHistory, turns.length, viewportRef]);

  const jumpToBottom = useCallback(() => {
    stickyRef.current = true;
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    }
    requestAnimationFrame(() => {
      const element = viewportRef.current;
      if (element && stickyRef.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [turns.length, viewportRef, virtualizer]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let lastScrollTop = element.scrollTop;
    let lastScrollHeight = element.scrollHeight;
    let lastClientHeight = element.clientHeight;
    const onScroll = () => {
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight <=
        AT_BOTTOM_THRESHOLD;
      if (atBottom) stickyRef.current = true;
      else if (
        element.scrollTop < lastScrollTop &&
        element.scrollHeight === lastScrollHeight &&
        Math.abs(element.clientHeight - lastClientHeight) <= 1
      ) {
        stickyRef.current = false;
      }
      lastScrollTop = element.scrollTop;
      lastScrollHeight = element.scrollHeight;
      lastClientHeight = element.clientHeight;
      if (element.scrollTop <= 320) requestOlderHistory();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyRef.current = false;
    };
    const disarm = () => {
      stickyRef.current = false;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", disarm, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", disarm);
    };
  }, [requestOlderHistory, viewportRef]);

  useEffect(() => {
    const element = viewportRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    // 追底写入合并到 rAF：一帧最多一次。折叠/展开的 200ms 高度动画会让消息列表
    // 每帧多次 resize，若每回调都同步写 scrollTop，帧内多次写入会用中途各不一致
    // 的 scrollHeight 互相覆盖，表现为滚到底时页面跳动/闪烁（展开尤其明显）。
    // 合并后统一在绘制前落笔，且只在「sticky 且当前不在最底部」时才写：
    // - 展开/流式增长：只要内容超出底部一帧，就在绘制前补回 → 平滑钉底；
    // - 收起/变矮：浏览器会自行把 scrollTop 钳制回新的最大可滚值，我们既不写也
    //   不会抖动，避免主动写造成的一次性过冲闪烁。
    let frame: number | undefined;
    const pinToBottom = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!stickyRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = element;
        const atBottom =
          scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_THRESHOLD;
        if (!atBottom) element.scrollTop = scrollHeight;
      });
    };
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [viewportRef]);

  useEffect(() => {
    const updateSelectionRange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionRange(null);
        return;
      }
      const turnIndex = (node: Node | null): number | undefined => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>("[data-virtual-turn-index]");
        if (!row || !contentRef.current?.contains(row)) return undefined;
        const index = Number(row.dataset.virtualTurnIndex);
        return Number.isInteger(index) ? index : undefined;
      };
      const anchor = turnIndex(selection.anchorNode);
      const focus = turnIndex(selection.focusNode);
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

  const previousIsRunningRef = useRef(false);
  const didInitialJumpRef = useRef(false);

  useLayoutEffect(() => {
    if (isRunning && !previousIsRunningRef.current && stickyRef.current) {
      jumpToBottom();
    }
    previousIsRunningRef.current = isRunning;
  }, [isRunning, jumpToBottom]);

  useLayoutEffect(() => {
    if (didInitialJumpRef.current || turns.length === 0) return;
    didInitialJumpRef.current = true;
    jumpToBottom();
  }, [jumpToBottom, turns.length]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0),
  );
  const messageComponents = useMemo(
    () => ({ Message: messageComponent }),
    [messageComponent],
  );

  return (
    <div
      ref={contentRef}
      data-slot="aui_virtualized-message-list"
      className="[overflow-anchor:none]"
      style={{ paddingTop, paddingBottom }}
    >
      {(historyHasMore || loadingMoreHistory || historyLoadError) && (
        <div
          data-slot="aui_history-loader"
          className="text-muted-foreground flex min-h-9 items-center justify-center gap-2 pb-3 text-xs"
          role="status"
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
      )}
      {items.map((item) => {
        const turn = turns[item.index];
        if (!turn) return null;
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-virtual-turn-index={item.index}
            data-slot="aui_thread-turn"
            className={
              item.index === turns.length - 1
                ? "flex flex-col gap-y-6"
                : "flex flex-col gap-y-6 pb-6"
            }
          >
            {turn.messageIds.map((messageId) => (
              <ThreadPrimitive.Unstable_MessageById
                key={messageId}
                messageId={messageId}
                components={messageComponents}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function useThreadMessageRows(): readonly ThreadMessageRow[] {
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
          row.role === message.role
        );
      })
    ) {
      return previous;
    }
    const next = messages.map(({ id, role }: ThreadMessage) => ({ id, role }));
    previousRowsRef.current = next;
    return next;
  });
}

function useThreadTurns(
  messageRows: readonly ThreadMessageRow[],
): readonly ThreadTurn[] {
  const previousTurnsRef = useRef<readonly ThreadTurn[]>([]);
  const turns = useMemo(
    () =>
      stabilizeThreadTurnIds(
        previousTurnsRef.current,
        buildThreadTurns(messageRows),
      ),
    [messageRows],
  );
  useLayoutEffect(() => {
    previousTurnsRef.current = turns;
  }, [turns]);
  return turns;
}
