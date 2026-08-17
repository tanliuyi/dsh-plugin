/** 数值钳制到 [min, max]。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** value/total 的百分比（0-100，钳制到边界）。total 非正数时返回 0。 */
export function pct(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}
