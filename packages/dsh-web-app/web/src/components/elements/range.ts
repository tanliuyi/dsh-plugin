/** Take a bounded prefix from an immutable element collection. */
export function take<T>(items: readonly T[], count: number): T[] {
  if (count === Number.POSITIVE_INFINITY) return [...items];
  if (!Number.isFinite(count)) return [];
  return items.slice(0, Math.max(0, Math.min(items.length, Math.trunc(count))));
}
