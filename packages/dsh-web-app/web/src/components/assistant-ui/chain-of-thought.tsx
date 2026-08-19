"use client";

import { ChainOfThoughtByIndicesProvider } from "@assistant-ui/react";
import type { FC } from "react";

import type { ChainOfThoughtProps } from "@/components/assistant-ui/chain-of-thought-model";
import { ChainOfThoughtPanel } from "@/components/assistant-ui/chain-of-thought-panel";

export type { ChainOfThoughtProps } from "@/components/assistant-ui/chain-of-thought-model";
export {
  hasTextAfterGroup,
  summarizeChainOfThought,
} from "@/components/assistant-ui/chain-of-thought-model";

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
      <ChainOfThoughtPanel startIndex={startIndex} endIndex={endIndex}>
        {children}
      </ChainOfThoughtPanel>
    </ChainOfThoughtByIndicesProvider>
  );
};
