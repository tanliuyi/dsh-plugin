/**
 * Shared surface class constants for the assistant-ui "elements" collection.
 * These mirror the official `elements/surfaces` module so components import
 * `./surfaces` and stay in sync with upstream.
 */

/** Bordered "paper" card surface. */
export const paper =
  "border-border/60 text-card-foreground border shadow-sm bg-card/60";

/** Monospace font stack for code surfaces. */
export const mono = "font-mono";

/** Scrollable code region. */
export const codeScroll = "overflow-x-auto";

/** The line stack inside a code surface. */
export const codeSurface = "flex flex-col";
