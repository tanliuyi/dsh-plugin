/**
 * 记忆查找文本归一化 — 让复制自 memory_search 结果的行可直接作为
 * replace/remove 的 old_text 使用。移植自 pi-hermes-memory/src/store/memory-lookup.ts。
 */

/**
 * 归一化查找文本：去掉首行前缀噪声（scope 标签、target 标签、分类标签）。
 * @param text - 原始查找文本
 * @returns 归一化后的文本；空白时返回空字符串
 */
export function normalizeMemoryLookupText(text: string): string {
  let normalized = text.trim()
  if (!normalized) return ''

  const firstNonEmptyLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstNonEmptyLine) normalized = firstNonEmptyLine

  // 当前 memory_search 结果使用 URL 编码的 scope 标记，任意项目名都不能提前终止前缀。
  normalized = normalized.replace(
    /^\S+\s+scope=(?:global|project:[^\s]+)\s+\[target=(?:memory|user|project|failure)\]\s+/u,
    '',
  )
  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, '')
  // memory_search 在 scope 之后标注变异目标。复制的搜索行要能直接用作查找文本。
  normalized = normalized.replace(/^\[target=(?:memory|user|project|failure)\]\s+/u, '')
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, '$1 ')

  return normalized.trim()
}
