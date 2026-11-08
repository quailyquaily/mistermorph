// Settings search: a chosen result opens its section, then scrolls to the row and marks it for a
// moment (the Vue page found the row in the DOM by its label; here rows register themselves).
//
// The page provides a `RevealRegistry`; SettingField, SettingToggleRow, SettingRow and SettingsCard
// register their label with a ref, and read `marked()` to show the mark.
import type { ViewRef } from "nsh";
import { type AnimatedNode, cleanup, context, createAnimatedValue, type Signal, signal, untracked } from "nsh";
import { MOTION_EASE, motionMs } from "../motion";

export interface RevealRegistry {
  /** Labels on screen, each with the views that show it (newest last). */
  rows: Map<string, Set<() => ViewRef | undefined>>;
  /** The label marked now ("" for none). */
  marked: Signal<string>;
  /** The mark's ring, shown for the first part of the mark (`@keyframes settings-search-hit` 0–40%). */
  ringed: Signal<boolean>;
  /** The marked row's background: accent 10%, held, then faded out (one value: one row at a time). */
  tint: AnimatedNode;
  /** Marks `text` for 2s: ring and tint, then the tint fades. */
  mark(text: string): void;
}

const HIT_MS = 2000;

export function createRevealRegistry(): RevealRegistry {
  const marked = signal("");
  const ringed = signal(false);
  const level = createAnimatedValue(0);
  let seq = 0;
  return {
    rows: new Map(),
    marked,
    ringed,
    tint: level.interpolate({ inputRange: [0, 1], outputRange: ["rgba(66,111,158,0)", "rgba(66,111,158,0.1)"] }),
    mark(text: string) {
      const run = ++seq;
      const duration = motionMs(HIT_MS);
      marked.set(text);
      ringed.set(true);
      level.set(1);
      if (duration > 0) void level.keyframes([1, { offset: 0.4, value: 1, easing: MOTION_EASE }, 0], { duration });
      setTimeout(() => {
        if (run === seq) ringed.set(false);
      }, HIT_MS * 0.4);
      setTimeout(() => {
        if (run === seq) marked.set("");
      }, HIT_MS);
    },
  };
}

export const RevealContext = context<RevealRegistry | null>(null);

/**
 * Registers a row by its label; returns the ref setter for its view and whether it is marked.
 * `label` is read once (rows keep their label).
 */
export function useRevealRow(label: () => string | undefined) {
  const registry = RevealContext();
  let node: ViewRef | undefined;
  const text = String(untracked(label) || "").trim();
  if (registry && text) {
    const get = () => node;
    let set = registry.rows.get(text);
    if (!set) {
      set = new Set();
      registry.rows.set(text, set);
    }
    set.add(get);
    cleanup(() => {
      const current = registry.rows.get(text);
      current?.delete(get);
      if (current && current.size === 0) registry.rows.delete(text);
    });
  }
  return {
    ref: (value: ViewRef) => {
      node = value;
    },
    marked: () => !!registry && !!text && registry.marked() === text,
    /** The ring part of the mark. */
    ringed: () => !!registry && !!text && registry.marked() === text && registry.ringed(),
    /** `style` for the row: the fading tint while marked. */
    style: (): Record<string, unknown> => (registry && text && registry.marked() === text ? { backgroundColor: registry.tint } : {}),
  };
}

/** The views registered for `text` that are on screen now. */
export async function findRow(registry: RevealRegistry, text: string) {
  const getters = [...(registry.rows.get(String(text || "").trim()) || [])];
  for (const get of getters.reverse()) {
    const node = get();
    if (!node) continue;
    const measured = await node.measure();
    if (measured && measured.bounds.size.height > 0) return { node, measured };
  }
  return null;
}
