// What the UI component gallery's demos share (pages/ui-components): a demo's shape, the labelled
// variant rows, synthetic text, and the local action log. A demo mounts the production component
// with props made here: nothing in a demo reads a live store or calls the console API, and every
// callback ends in `act(...)`, which only notes what was pressed.
import type { JSX } from "nsh";
import { Scroll, signal, Text, View } from "nsh";
import { translate } from "../../lib/i18n/index.js";

export interface Demo {
  render: () => JSX.Element;
  /** Takes the whole row whatever the window's width (a pane, a table, a composer). */
  wide?: boolean;
}
export type DemoMap = Record<string, Demo>;

/** The console's strings (the one catalog, lib/i18n): the gallery's own keys start with `uig_`. */
export function t(key: string, vars?: Record<string, unknown>): string {
  return String(translate(key, (vars ?? null) as never));
}

const lastAction = signal("");
const actionCount = signal(0);
/** What a demo's control did last: shown in the gallery's head, kept in memory only. */
export const galleryAction = () => lastAction();
export const galleryActionCount = () => actionCount();
/** A demo callback: notes the action and does nothing else. */
export function act(name: string, detail?: unknown) {
  lastAction.set(detail === undefined || detail === "" ? name : `${name}: ${String(detail)}`);
  actionCount.update((n) => n + 1);
}
/** A callback that notes `name` with whatever it was called with. */
export const acts =
  (name: string) =>
  (detail?: unknown): void =>
    act(name, typeof detail === "object" ? "" : detail);

/** Mixed-script text that does not fit a line, for wrapping and truncation. */
export const LONG_TEXT =
  "A deliberately long synthetic line that keeps going well past the edge of a narrow phone screen, 然后继续用中文写下去，看看换行和截断是否正常，さらに日本語でも続けて、折り返しと省略の表示を確かめます。";
export const LONG_WORD = "an_unbroken_identifier_without_any_spaces_that_cannot_wrap_at_a_word_boundary_0123456789";
/** A fixed moment for anything a demo dates (never the clock). */
export const FIXED_ISO = "2026-03-14T09:26:53Z";
export const FIXED_MS = Date.parse(FIXED_ISO);

const STATES = ["default", "selected", "disabled", "loading", "empty", "error", "long", "open", "closed", "readonly", "on", "off", "busy", "filled"] as const;
export type DemoState = (typeof STATES)[number];

/**
 * One variant of a component: a small label over it. `s` is a state the gallery names in the
 * page's language; `l` is a literal label (a prop value such as `primary`).
 */
export function V(props: { s?: DemoState; l?: string; row?: boolean; class?: string; children?: JSX.Element }) {
  const label = () => [props.s ? t(`uig_state_${props.s}`) : "", props.l ?? ""].filter(Boolean).join(" · ");
  return (
    <View class={`min-w-0 gap-1.5 ${props.class ?? ""}`}>
      <Text class="font-mono text-[10px] uppercase tracking-[0.6px] text-muted-foreground">{label()}</Text>
      <View class={props.row ? "flex-row flex-wrap items-center gap-2" : "gap-2"}>{props.children}</View>
    </View>
  );
}

/** Variants side by side, wrapping on narrow screens. */
export function Row(props: { class?: string; children?: JSX.Element }) {
  return <View class={`flex-row flex-wrap items-start gap-x-5 gap-y-4 ${props.class ?? ""}`}>{props.children}</View>;
}

/** Variants one under another. */
export function Col(props: { class?: string; children?: JSX.Element }) {
  return <View class={`gap-4 ${props.class ?? ""}`}>{props.children}</View>;
}

/** A local on/off value for a demo's own state. */
export function useFlag(initial = false) {
  const value = signal(initial);
  return { on: () => value(), set: (next: boolean) => value.set(next), toggle: () => value.update((v) => !v) };
}

/** A local string for a demo's own state. */
export function useText(initial = "") {
  const value = signal(initial);
  return { get: () => value(), set: (next: string) => value.set(String(next ?? "")) };
}

/**
 * A demo wider than its card (a table, or a variant whose text does not wrap): it scrolls sideways
 * inside the card, so the page itself never does.
 */
export function Wide(props: { class?: string; children?: JSX.Element }) {
  return (
    <Scroll horizontal class={`max-w-full self-stretch ${props.class ?? ""}`} contentClass="flex-row items-start pb-2">
      {props.children}
    </Scroll>
  );
}
