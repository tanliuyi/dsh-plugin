/**
 * Shared surface class constants for the assistant-ui "elements" collection.
 * These mirror the official `elements/surfaces` module so components import
 * `./surfaces` and stay in sync with upstream.
 */

/** Bordered "paper" card surface. */
export const paper =
  "border-border/60 text-card-foreground border shadow-sm bg-card/60";

/** A compact field surface used inside element disclosures. */
export const field = "border-border/60 bg-card/60 border shadow-sm";

/** Monospace font stack for code surfaces. */
export const mono = "font-mono";

/** Scrollable code region. */
export const codeScroll = "overflow-x-auto";

/** The line stack inside a code surface. */
export const codeSurface = "flex flex-col";

/** Shared disclosure motion used by assistant-ui element panels. */
export const collapsePanel =
  "relative overflow-hidden ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none data-closed:animate-collapsible-up data-open:animate-collapsible-down data-closed:fill-mode-forwards data-closed:pointer-events-none data-open:duration-200 data-closed:duration-200";
