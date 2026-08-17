import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * 共享表面样式 —— 设计语言的最小原子集（tailwind class 字符串）。
 * 全部与调用方的 className 经 tailwind-merge 合并，调用方负责尺寸/圆角/间距；
 * 这里只约定：表面层级、边框、背景、文字色与过渡。
 */

/** 次级内嵌表面：选中项、附件 chip、排队项、文本输入框、命令展示框。 */
export const field =
  "border border-foreground/[0.08] bg-foreground/[0.05] text-foreground";

/** 卡片表面：composer 输入条、消息/队列卡片、表单、审批卡。 */
export const paper =
  "border border-foreground/[0.08] bg-background text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

/** 悬浮层表面：命令菜单、上下文气泡等浮层。 */
export const floating =
  "bg-popover/95 text-popover-foreground border border-foreground/[0.08] shadow-lg backdrop-blur-sm";

/** 幽灵按钮：图标按钮/次级操作。调用方补尺寸。 */
export const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/55 transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96]";

/** 墨色主按钮：发送/确认等主要操作。调用方补 display/尺寸/圆角。 */
export const inkButton =
  "bg-foreground text-background font-medium transition-[background-color,color,scale] duration-150 hover:bg-foreground/90 active:scale-[0.96]";

/** 等宽字。 */
export const mono = "font-mono";

/** 图标互换动画基座：两图标重叠在同一网格单元，互切透明度与缩放。 */
export const iconSwap =
  "col-start-1 row-start-1 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

/** 进入态。 */
export const iconSwapIn = "scale-100 opacity-100";

/** 退出态。 */
export const iconSwapOut = "scale-50 opacity-0";

/** 文字微光标签（tw-shimmer 的 text shimmer）。 */
export function ShimmerLabel({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("shimmer", className)} {...props} />;
}
