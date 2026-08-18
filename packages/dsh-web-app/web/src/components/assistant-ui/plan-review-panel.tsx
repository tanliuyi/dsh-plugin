"use client";

/**
 * PlanReviewPanel：`plan-review` 呈现意图的接管组件。一份待审计划是一个决策、
 * 一段 markdown，所以取「等待批准卡」的形状——amber 条带 + 可滚动正文 + 右侧
 * 决策行——而不是通用提问流程的翻页、编号选项、跳过与自定义答案（那读起来像
 * 一场被考核的测验）。
 *
 * 三个动作就是整个决策面：确认执行/拒绝用求问方自己的选项 label 回答案
 * （intent 指名哪个 label 表示批准，裁决不依赖选项顺序），description 保留为
 * title；「去聊天里说」关闭请求让编辑器归位，用户直接说出他想说的话。
 * 任一点击锁住全部动作直到落定；发送被拒绝（transport/reject）显示 role=status
 * 错误并重新武装，否则用户永远不会知道那次点击丢了。
 */

import { useState, type FC } from "react";
import { PencilIcon } from "lucide-react";

import { MarkdownStatic } from "@/components/assistant-ui/markdown-static";
import {
  approveResponse,
  cancelResponse,
  declineResponse,
  type PlanReview,
} from "@/dsh/plan-review";
import { paper } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

export interface PlanReviewPanelProps {
  /** 请求 rpcId：data 钩点 + 应答回显。 */
  rpcId: string;
  /** 归属会话 id：被审计划所在会话。 */
  sessionId: string;
  /** 收窄后的计划审阅（命中 planReviewOf 才渲染本面板）。 */
  review: PlanReview;
  /** store 的 respondToInteraction：HTTP 2xx 后移除待处理交互，失败时 reject。 */
  onRespond: (
    rpcId: string,
    result: { ok: boolean; value?: unknown; error?: unknown },
  ) => Promise<void>;
}

export const PlanReviewPanel: FC<PlanReviewPanelProps> = ({
  rpcId,
  sessionId,
  review,
  onRespond,
}) => {
  // 一次性闩锁：面板只在宿主 resolved 帧落地/失败重武装后能再次发送，避免双击重发。
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settle = (send: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void send().catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const decline = review.decline;
  // declineResponse 需要 decline 存在；按钮只在 decline 定义时渲染，这里显式收窄。
  const reject = () => {
    if (decline === undefined) return;
    settle(() =>
      onRespond(rpcId, declineResponse(sessionId, { ...review, decline })),
    );
  };

  return (
    <div data-plan-review-key={rpcId} className="w-full min-w-0">
      <section
        aria-label={review.question}
        className={cn(
          paper,
          "flex w-full max-w-none flex-col overflow-hidden rounded-[20px] border-amber-500/60",
        )}
      >
        <div className="border-amber-500/60 bg-amber-500/10 text-amber-700 flex min-h-9 shrink-0 items-center gap-2 border-b px-4 py-2 text-sm dark:text-amber-300">
          <span
            className="bg-amber-500 size-2 shrink-0 rounded-full"
            aria-hidden="true"
          />
          <span className="font-medium">计划待审</span>
        </div>

        <div
          data-plan-review-scroll
          className="max-h-[min(60vh,520px)] min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-1 text-sm leading-6"
        >
          <MarkdownStatic text={review.plan} />
        </div>

        <div className="flex w-full max-w-full shrink-0 flex-wrap items-center justify-between gap-2 px-4 pt-1 pb-3">
          <div
            role="status"
            className="text-destructive min-h-4 min-w-0 flex-1 break-words whitespace-pre-wrap text-[11px] leading-4"
          >
            {error}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => settle(() => onRespond(rpcId, cancelResponse(sessionId)))}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              <PencilIcon className="size-3.5" aria-hidden="true" />
              去聊天里说
            </button>
            {decline !== undefined ? (
              <button
                type="button"
                disabled={busy}
                title={decline.description}
                onClick={reject}
                className="border-border bg-background text-foreground hover:bg-muted inline-flex h-8 items-center justify-center rounded-full border px-3.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
              >
                拒绝
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              title={review.approve.description}
              onClick={() =>
                settle(() =>
                  onRespond(rpcId, approveResponse(sessionId, review)),
                )
              }
              className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-8 items-center justify-center rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              确认执行
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
