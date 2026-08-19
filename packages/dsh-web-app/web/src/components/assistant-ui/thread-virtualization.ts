export interface ThreadMessageRow {
  id: string;
  role: "user" | "assistant" | "system";
}

export interface ThreadTurn {
  id: string;
  messageIds: readonly string[];
}

const HISTORY_PREFETCH_MIN_DISTANCE = 800;
const HISTORY_PREFETCH_VIEWPORTS = 1.5;

export function shouldPrefetchOlderHistory(
  scrollTop: number,
  clientHeight: number,
): boolean {
  const threshold = Math.max(
    HISTORY_PREFETCH_MIN_DISTANCE,
    clientHeight * HISTORY_PREFETCH_VIEWPORTS,
  );
  return scrollTop <= threshold;
}

export function mergeSelectedVirtualIndexes(
  indexes: readonly number[],
  selection: { start: number; end: number },
  count: number,
): number[] {
  const merged = new Set(
    indexes.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < count,
    ),
  );
  const start = Math.max(0, selection.start);
  const end = Math.min(count - 1, selection.end);
  for (let index = start; index <= end; index += 1) merged.add(index);
  return [...merged].sort((left, right) => left - right);
}

export function buildThreadTurns(
  messages: readonly ThreadMessageRow[],
): readonly ThreadTurn[] {
  const turns: { id: string; messageIds: string[] }[] = [];
  for (const { id, role } of messages) {
    const last = turns.at(-1);
    if (role === "user" || !last) turns.push({ id, messageIds: [id] });
    else last.messageIds.push(id);
  }
  return turns;
}

/** Keep a turn mounted under the same key when a snapshot replaces some IDs. */
export function stabilizeThreadTurnIds(
  previous: readonly ThreadTurn[],
  current: readonly ThreadTurn[],
): readonly ThreadTurn[] {
  if (previous.length === 0 || current.length === 0) return current;

  const previousTurnIdByMessageId = new Map<string, string>();
  for (const turn of previous) {
    for (const messageId of turn.messageIds) {
      previousTurnIdByMessageId.set(messageId, turn.id);
    }
  }

  const reusedTurnIds = new Set<string>();
  let changed = false;
  const stabilized = current.map((turn) => {
    const previousTurnId = turn.messageIds
      .map((messageId) => previousTurnIdByMessageId.get(messageId))
      .find((turnId) => turnId !== undefined && !reusedTurnIds.has(turnId));
    const id = previousTurnId ?? turn.id;
    reusedTurnIds.add(id);
    if (id === turn.id) return turn;
    changed = true;
    return { ...turn, id };
  });

  return changed ? stabilized : current;
}
