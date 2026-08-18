/** plan-review 呈现意图（对齐上游 ui-user-questions 的 contract/slots.ts）：
 *  唯一问题 + 计划正文渲染成一张等待批准的决策卡，而不是通用提问表单。 */

import type { Question, QuestionOption } from './api'

/** 一份可渲染的计划审阅：卡片只需要求问方自己提供的选项与计划正文，
 *  不再重读请求形状。approve/decline 是求问方自己的选项——答案必须原样携带其一。 */
export interface PlanReview {
  /** 被审问题的 id，答案中回显。 */
  id: string
  /** 问题文本，作为卡片 section 的无障碍名称。 */
  question: string
  /** 待审的计划 markdown 正文。 */
  plan: string
  /** 批准该计划的选项。 */
  approve: QuestionOption
  /** 拒绝选项；求问方只给出 approve 一个选项时缺省。 */
  decline?: QuestionOption
}

/** 成功决策（approve/decline 共用同一 envelope，仅 label 不同）。 */
export interface PlanReviewOkValue {
  sessionId: string
  answer: { answers: { id: string; selected: string[] }[] }
}

/** 关闭请求的已取消错误（对齐上游 ask-cancelled 编码）。 */
export interface PlanReviewCancelError {
  code: 'cancelled'
  message: string
  details: Record<string, never>
}

export type PlanReviewResponse =
  | { ok: true; value: PlanReviewOkValue }
  | { ok: false; error: PlanReviewCancelError }

/**
 * 把整个问题批次收窄成一份 plan review；不满足时返回 undefined，留给通用提问流程。
 *
 * 决策卡只认领它能送出该请求允许的每一个答案的请求：单一问题、intent 声明了
 * plan-review、计划以 detail 存在（空串也是有效正文）、multiSelect !== true、
 * 至多两个选项、intent.approve 精确命中某个 option.label。其余任一情形——
 * 多问题、无 intent、缺 detail、approve 未命中、第三个选项、多选决定——都留给
 * 能表达它的通用流程。意图只改布局，绝不改变可达答案。
 *
 * @param questions - 请求的整个问题批次。
 * @returns 收窄后的审阅，或 undefined 由通用流程接管。
 */
export function planReviewOf(questions: readonly Question[]): PlanReview | undefined {
  if (questions.length !== 1) return undefined
  // 上面已长度检查；下标读取是收窄的代价，不是猜测。
  const question = questions[0] as Question
  const intent = question.intent
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find((option) => option.label === intent.approve)
  if (approve === undefined) return undefined
  const decline = options.find((option) => option.label !== intent.approve)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  }
}

/** 成功决策信封：用请求原始 label 回答（裁决绝不依赖选项顺序）。 */
export function decisionResponse(
  sessionId: string,
  id: string,
  label: string,
): { ok: true; value: PlanReviewOkValue } {
  return { ok: true, value: { sessionId, answer: { answers: [{ id, selected: [label] }] } } }
}

/** 批准：以 review.approve 的原样 label 应答。 */
export function approveResponse(sessionId: string, review: PlanReview): { ok: true; value: PlanReviewOkValue } {
  return decisionResponse(sessionId, review.id, review.approve.label)
}

/** 拒绝：以 review.decline 的原样 label 应答；没有 decline 选项时不应调用。 */
export function declineResponse(
  sessionId: string,
  review: PlanReview & { decline: NonNullable<PlanReview['decline']> },
): { ok: true; value: PlanReviewOkValue } {
  return decisionResponse(sessionId, review.id, review.decline.label)
}

/** 关闭请求：让 composer 归位，用户直接说出他想说的。 */
export function cancelResponse(sessionId: string): { ok: false; error: PlanReviewCancelError } {
  return {
    ok: false,
    error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
  }
}
