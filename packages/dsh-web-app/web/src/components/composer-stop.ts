/**
 * 双 Esc 停止与主发送/停止按钮档位的纯逻辑。组件只负责把 store / assistant-ui
 * 的 running、composer.isEmpty 与本地 armed 状态喂给这里的纯函数，副作用（定时器、
 * 焦点、RPC）都留在组件层，方便用 node:test 单测状态机本身。
 */

/** 第一次 Esc 之后等待第二次 Esc 的窗口长度（毫秒）。 */
export const STOP_ARM_WINDOW_MS = 1_000

export interface EscTransition {
  /** 双 Esc 窗口是否开启（第一次 Esc 后为 true，等待第二次）。 */
  armed: boolean
  /** 本次 Esc 是否应当触发停止（armed 状态下第二次 Esc）。 */
  stop: boolean
}

/**
 * 单步 Esc 状态机转换：
 * - 非 Esc（超时、运行结束、重置等）必然解除 armed 且不触发停止；
 * - idle 下的第一次 Esc → armed（只布防）；
 * - armed 下的第二次 Esc → 解除并以 stop 通知组件执行停止。
 * 由此「单次 Esc 永远不停止」，只有 1 秒窗口内的第二次 Esc 才停止。
 */
export function advanceEsc(armed: boolean, escapePressed: boolean): EscTransition {
  if (!escapePressed) return { armed: false, stop: false }
  if (armed) return { armed: false, stop: true }
  return { armed: true, stop: false }
}

/**
 * 主发送/停止按钮档位（复用既有发送/停止形态，组合成单一按钮的换图标逻辑）：
 * - idle：普通发送（ArrowUp）；
 * - running 且输入非空：steer（发送箭头，点击/Enter 直接注入引导消息）；
 * - running 且输入为空：停止（Square）；
 * - armed（双 Esc 窗口内）且 running：固定显示文字 Esc。
 */
export type ComposerPrimaryAction = 'send' | 'steer' | 'stop' | 'esc'

export interface ComposerPrimaryActionInput {
  running: boolean
  isEmpty: boolean
  armed: boolean
}

export function primaryActionOf({
  running,
  isEmpty,
  armed,
}: ComposerPrimaryActionInput): ComposerPrimaryAction {
  if (armed && running) return 'esc'
  if (!running) return 'send'
  return isEmpty ? 'stop' : 'steer'
}
