import {
  ChainOfThoughtPrimitive,
  useAuiState,
  type AssistantState,
} from "@assistant-ui/react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PropsWithChildren,
} from "react";

import { ChainOfThoughtContent } from "@/components/assistant-ui/chain-of-thought-content";
import {
  CHAIN_OF_THOUGHT_ANIMATION_MS,
  hasTextAfterIndex,
  summarizeChainOfThoughtRange,
} from "@/components/assistant-ui/chain-of-thought-model";
import { ChainOfThoughtTrigger } from "@/components/assistant-ui/chain-of-thought-trigger";

export function ChainOfThoughtPanel({
  startIndex,
  endIndex,
  children,
}: PropsWithChildren<{ startIndex: number; endIndex: number }>) {
  const selectLabel = useCallback(
    (state: AssistantState) =>
      summarizeChainOfThoughtRange(state.message.parts, startIndex, endIndex),
    [endIndex, startIndex],
  );
  const selectHasFollowingText = useCallback(
    (state: AssistantState) => hasTextAfterIndex(state.message.parts, endIndex),
    [endIndex],
  );
  const label = useAuiState(selectLabel);
  const hasFollowingText = useAuiState(selectHasFollowingText);
  const running = useAuiState(
    (state) => state.chainOfThought.status?.type === "running",
  );
  const collapsed = useAuiState((state) => state.chainOfThought.collapsed);

  const wasRunningRef = useRef(false);
  const previousStartIndexRef = useRef(startIndex);
  useLayoutEffect(() => {
    if (previousStartIndexRef.current !== startIndex) {
      previousStartIndexRef.current = startIndex;
      wasRunningRef.current = false;
      return;
    }
    if (running) wasRunningRef.current = true;
  }, [running, startIndex]);

  const engagedRef = useRef(false);
  const engage = useCallback(() => {
    engagedRef.current = true;
  }, []);
  const autoOpen = wasRunningRef.current && !hasFollowingText;
  const open = engagedRef.current ? !collapsed : running || autoOpen;
  const preview = running && open;

  return (
    <ChainOfThoughtPrimitive.Root
      data-slot="aui_chain-of-thought"
      data-state={open ? "open" : "closed"}
      className="aui-chain-of-thought-root border-none bg-background/90 my-3 overflow-hidden rounded-xl border"
      style={
        {
          "--animation-duration": `${CHAIN_OF_THOUGHT_ANIMATION_MS}ms`,
        } as CSSProperties
      }
    >
      <ChainOfThoughtTrigger
        label={label}
        running={running}
        open={open}
        onEngage={engage}
      />
      <ChainOfThoughtContent open={open} preview={preview}>
        {children}
      </ChainOfThoughtContent>
    </ChainOfThoughtPrimitive.Root>
  );
}
