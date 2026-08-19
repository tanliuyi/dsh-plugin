type MessageContentPartLike = {
  type: string;
  name?: string;
};

function isOnlyNamedDataContent(
  content: readonly MessageContentPartLike[],
  name: string,
): boolean {
  return (
    content.length === 1 &&
    content[0]?.type === "data" &&
    content[0].name === name
  );
}

export function isContextOnlyContent(
  content: readonly MessageContentPartLike[],
): boolean {
  return isOnlyNamedDataContent(content, "dsh-context");
}

export function isCompactionOnlyContent(
  content: readonly MessageContentPartLike[],
): boolean {
  return isOnlyNamedDataContent(content, "dsh-compaction");
}
