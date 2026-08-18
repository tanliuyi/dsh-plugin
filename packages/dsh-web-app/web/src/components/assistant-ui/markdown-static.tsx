"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createContext,
  useContext,
  useMemo,
  type ComponentProps,
  type FC,
} from "react";

import { markdownComponents } from "@/components/assistant-ui/markdown-text";
import { cn } from "@/lib/utils";

/**
 * 静态 markdown 里复现消息体渲染器的「块级/行内 code」判定：MarkdownText 由
 * 助手 UI 的渲染器注入 pre 上下文（PreOverride），裸 react-markdown 没有这个
 * 上下文。这里用本模块自己的 context 提供同一判定。pre 不复用共享组件的
 * markdownComponents.pre——那是给配 CodeHeader 的消息代码块用的
 * （rounded-t-none border-t-0）；静态渲染没有 CodeHeader，StaticPre 自己渲染
 * 完整代码块 pre（rounded-xl、保留四边 border），其余组件继续复用共享组件。
 * code 仅在不在块内时才套行内 pill。
 */
const StaticBlockCodeContext = createContext(false);

const StaticPre: FC<ComponentProps<"pre">> = ({ className, ...props }) => (
  <StaticBlockCodeContext.Provider value={true}>
    <pre
      className={cn(
        "aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-xl border p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  </StaticBlockCodeContext.Provider>
);

const StaticCode: FC<ComponentProps<"code">> = ({ className, ...props }) => {
  const inBlock = useContext(StaticBlockCodeContext);
  return (
    <code
      className={cn(
        !inBlock &&
          "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  );
};

/**
 * 显式、安全的 string → markdown 静态渲染器：react-markdown（直接依赖）+
 * remark-gfm，复用 `markdownComponents`（与助手消息同款组件/样式）。
 * 不启用 rehypeRaw，raw HTML 原样转义为文本；URL 走 react-markdown 的默认
 * sanitize。不用 dangerouslySetInnerHTML、不写自制 parser。
 */
export const MarkdownStatic: FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => {
  const components = useMemo<Components>(
    () => ({ ...markdownComponents, pre: StaticPre, code: StaticCode }),
    [],
  );
  return (
    <div className={cn("aui-md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};
