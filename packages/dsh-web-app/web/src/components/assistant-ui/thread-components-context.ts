import { createContext, type ComponentType, type PropsWithChildren } from "react";
import {
  MessagePrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  /** @deprecated Reasoning parts render directly inside ChainOfThought. */
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export const EMPTY_THREAD_COMPONENTS: ThreadComponents = {};

export const ThreadComponentsContext = createContext<ThreadComponents>(
  EMPTY_THREAD_COMPONENTS,
);
