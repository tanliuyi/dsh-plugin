/**
 * 让一个嵌套滚动视口在其渲染内容增长时保持钉在底部（滚动跟随）。
 *
 * 移植自 meta-agent-v2 的同名工具。与「ResizeObserver 回调里每帧同步写
 * scrollTop」的做法不同，这里把写入合并到一个 rAF 里：一帧最多执行一次
 * `scrollTop = scrollHeight`，避免 200ms 折叠高度动画 / 流式增长期间多路
 * 同步写入互相竞争导致的布局抖动与页面闪烁（外层 viewport 的待写合并，
 * 配合滚动容器自身的合成层动画）。非溢出的容器（scrollHeight <= clientHeight）
 * 直接跳过，不做无意义的写入。
 *
 * `respectUserScroll` 只在显式开启时挂载 scroll 监听，并遵循 assistant-ui
 * 的滚动规则：只有「内容高度不变时向上滚动」才视为用户意图，暂停跟随；
 * 回到底部则恢复。
 */
const BOTTOM_THRESHOLD_PX = 1;

interface BottomFollowViewport {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  addEventListener(type: "scroll", listener: EventListener): void;
  removeEventListener(type: "scroll", listener: EventListener): void;
}

interface BottomFollowOptions {
  respectUserScroll?: boolean;
}

/** Keep a nested scroll viewport pinned as its rendered content grows, following assistant-ui's scroll-state rules. */
export function followResizingContentToBottom(
  viewport: BottomFollowViewport,
  content: Element,
  { respectUserScroll = false }: BottomFollowOptions = {},
): () => void {
  let frame: number | undefined;
  let following = true;
  let lastScrollTop = viewport.scrollTop;
  let lastScrollHeight = viewport.scrollHeight;

  const handleScroll = () => {
    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const isAtBottom =
      scrollHeight <= clientHeight ||
      Math.abs(scrollHeight - scrollTop - clientHeight) <= BOTTOM_THRESHOLD_PX;
    // assistant-ui only treats an upward movement with stable content as user input.
    const userScrolledUp =
      scrollTop < lastScrollTop && scrollHeight === lastScrollHeight;

    if (isAtBottom) following = true;
    else if (userScrolledUp) following = false;

    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
  };

  const pin = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!following || viewport.scrollHeight <= viewport.clientHeight) return;
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop = viewport.scrollTop;
      lastScrollHeight = viewport.scrollHeight;
    });
  };

  const observer = new ResizeObserver(pin);
  observer.observe(content);
  if (respectUserScroll) viewport.addEventListener("scroll", handleScroll);
  pin();

  return () => {
    observer.disconnect();
    if (respectUserScroll) viewport.removeEventListener("scroll", handleScroll);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
