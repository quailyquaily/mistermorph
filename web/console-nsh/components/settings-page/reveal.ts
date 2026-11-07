// Settings search: a chosen result opens its section, then scrolls to the row and marks it for a
// moment (the Vue page found the row in the DOM by its label; here rows register themselves).
//
// The page provides a `RevealRegistry`; SettingField, SettingToggleRow, SettingRow and SettingsCard
// register their label with a ref, and read `marked()` to show the mark.
import type { ViewRef } from "nsh";
import { cleanup, context, type Signal, signal, untracked } from "nsh";

export interface RevealRegistry {
  /** Labels on screen, each with the views that show it (newest last). */
  rows: Map<string, Set<() => ViewRef | undefined>>;
  /** The label marked now ("" for none). */
  marked: Signal<string>;
}

export function createRevealRegistry(): RevealRegistry {
  return { rows: new Map(), marked: signal("") };
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
