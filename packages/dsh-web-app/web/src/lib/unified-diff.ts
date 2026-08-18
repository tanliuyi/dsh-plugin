/**
 * Minimal unified/git diff text parser feeding the assistant-ui CodeDiff
 * element (`@/components/elements/code-diff`). Tool results and ```diff
 * markdown blocks are free-form text; this maps them to
 * `{ filename, additions, deletions, lines }`.
 */

import type { DiffLine } from "@/components/elements/code-diff";

export interface ParsedDiff {
  filename: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  /** Increment to replay the entrance animation. */
  cycle: number;
}

const GIT_HEADER = /^diff --git a\/(.*?)(?:\s*)b\/(.*)$/;
const OLD_FILE_HEADER = /^--- .*$/;
const NEW_FILE_HEADER = /^\+\+\+ b\/(.*?)(?:\s*)$/;
const INDEX_LINE = /^index [0-9a-f]{7,}/;
const META_LINE =
  /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to|Binary files|GIT binary patch) /;
const NO_NEWLINE = /^\\ No newline at end of file$/;

/**
 * Whether a string looks like a unified diff: either a `diff --git` header
 * or a `--- a/…` + `+++ b/…` file header pair. Specific enough that ordinary
 * prose or short tool results do not match.
 */
export function isUnifiedDiff(text: string): boolean {
  if (typeof text !== "string") return false;
  const source = text.replace(/^\uFEFF/, "");
  if (/(^|\n)diff --git a\//m.test(source)) return true;
  return (
    /(^|\n)--- (?:a\/|")/.test(source) &&
    /(^|\n)\+\+\+ (?:b\/|")/.test(source)
  );
}

/** Strip the quoting git uses for paths containing spaces. */
function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

/** Split text into diff lines, treating a single trailing newline as the
 *  terminator of the last line (no spurious empty row) and empty text as []. */
function splitDiffLines(input: string): string[] {
  const text = input.replace(/^\uFEFF/, "").replace(/\n$/, "");
  if (text === "") return [];
  return text.split("\n");
}

/**
 * Build a CodeDiff from the dsh `write` tool args: the new file content is
 * shown as an all-added block, mirroring the harness's `presentCall` card
 * (no `before` is available client-side).
 */
export function diffFromWrite(
  filePath: string,
  content: string,
  cycle = 0,
): ParsedDiff {
  const body = splitDiffLines(content);
  return {
    filename: filePath,
    additions: body.length,
    deletions: 0,
    lines: body.map((line): DiffLine => ({ kind: "added", text: line })),
    cycle,
  };
}

/**
 * Build a CodeDiff from the dsh `edit` tool args: the removed literal block
 * followed by the replacement literal block, mirroring the harness's
 * `presentCall` card for edit.
 */
export function diffFromEdit(
  filePath: string,
  oldString: string,
  newString: string,
  cycle = 0,
): ParsedDiff {
  const removed = splitDiffLines(oldString);
  const added = splitDiffLines(newString);
  return {
    filename: filePath,
    additions: added.length,
    deletions: removed.length,
    lines: [
      ...removed.map((line): DiffLine => ({ kind: "removed", text: line })),
      ...added.map((line): DiffLine => ({ kind: "added", text: line })),
    ],
    cycle,
  };
}

/**
 * Parse a unified diff string into CodeDiff props. Returns `null` when the
 * input is not a diff. Metadata/header lines (`diff --git`, `---/+++`,
 * `index`, mode lines, `\ No newline…`) are skipped; `+`/`-` hunks become
 * added/removed lines; everything else (including `@@` hunk headers and
 * context) becomes a context line. The filename prefers the `+++ b/…` name,
 * falling back to the `diff --git` new-file name.
 */
export function parseUnifiedDiff(
  text: string,
  cycle = 0,
): ParsedDiff | null {
  if (!isUnifiedDiff(text)) return null;

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let filename = "diff";

  for (const rawLine of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = rawLine.trimEnd();

    const git = GIT_HEADER.exec(line);
    if (git) {
      filename = unquotePath(git[2] ?? git[1] ?? "diff");
      continue;
    }
    if (OLD_FILE_HEADER.test(line)) continue;
    const newFile = NEW_FILE_HEADER.exec(line);
    if (newFile) {
      filename = unquotePath(newFile[1]);
      continue;
    }
    if (
      INDEX_LINE.test(line) ||
      META_LINE.test(line) ||
      NO_NEWLINE.test(line)
    ) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      lines.push({ kind: "added", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
      lines.push({ kind: "removed", text: line.slice(1) });
      continue;
    }

    lines.push({ kind: "context", text: line });
  }

  return { filename, additions, deletions, lines, cycle };
}
