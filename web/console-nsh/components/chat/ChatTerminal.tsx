// The dark terminal the detail panel (pages/chat/ActivityDetailPanel.tsx) draws a reply's plan,
// progress and its workers' output on, on every screen, as in the Vue console: its own ink (the
// page's foreground with a touch of blue), light text, and the theme's light accents for status.
// One surface and one set of text styles, so the plan, the progress (ChatStatusCard.tsx) and a
// coder's or subagent's output (ChatWorkerRoster.tsx) look alike.
import type { JSX } from "nsh";
import { View } from "nsh";

export const TERMINAL_BG = "bg-[#1b1f3b]";
/** Titles and plain lines. */
export const TERMINAL_FG = "text-[#e8eef5]";
/** Labels, times and counts. */
export const TERMINAL_MUTED = "text-[#d5e0ecb2]";
/** What a tool or worker printed. */
export const TERMINAL_NOTE = "text-[#e8eef5d1]";
/** A parameter's value. */
export const TERMINAL_VALUE = "text-[#d9e3ee]";
/** An error. */
export const TERMINAL_ERROR = "text-[#e08a9e]";

/** A small uppercase label: an entry's kind, an output's section. */
export const TERMINAL_LABEL = `font-mono text-xs uppercase ${TERMINAL_MUTED}`;
/** Printed output, or the error that stands in for it. */
export function terminalNoteClass(error?: boolean) {
  return `text-xs ${error ? TERMINAL_ERROR : TERMINAL_NOTE}`;
}

/**
 * The terminal's surface: rounded like the page's controls, 12pt inside, 8pt between entries.
 * `flush`: the panel around it is the terminal (the workbench), so no surface of its own, only the
 * panel's 16pt inset at the sides.
 */
export function ChatTerminal(props: { children?: JSX.Element; flush?: boolean; testID?: string }) {
  return (
    <View class={`gap-2 ${props.flush ? "px-4 pb-4 pt-1" : `rounded-(--radius) p-3 ${TERMINAL_BG}`}`} testID={props.testID ?? "chat-terminal"}>
      {props.children}
    </View>
  );
}
