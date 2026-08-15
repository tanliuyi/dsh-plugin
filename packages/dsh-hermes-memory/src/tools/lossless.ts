/**
 * 工具输出归一化 — 去掉 undefined 字段，保证 lossless JSON 校验通过。
 * （dsh 工具执行器对返回值做 lossless-JSON 校验，对象里的 undefined 值会被拒绝。）
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * 把普通对象转换为 lossless JSON：删除值为 undefined 的字段（含嵌套对象与数组元素）。
 * @param value - 工具返回值
 * @returns 无 undefined 字段的 JSON 值
 */
export function lossless(value: unknown): JsonValue {
  return stripUndefined(value) as JsonValue
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item))
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (item === undefined) continue
      result[key] = stripUndefined(item)
    }
    return result
  }
  return value
}
