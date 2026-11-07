// Per-item state of the chat's virtualized rows. A List cell is reused for other items as it
// scrolls, so nothing an item owns (a draft answer, a folded section, an artifact preview) can live
// in a signal made inside the row: it lives here, keyed by the item's id, and the row reads it.
import { signal, untracked } from "nsh";

/** A record of values by key, as one signal: rows read `get(key)` in their bindings. */
export interface KeyedState<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  update(key: string, fn: (value: T | undefined) => T | undefined): void;
  delete(key: string): void;
  clear(): void;
  /** Every key with a value, read untracked. */
  keys(): string[];
}

export function keyedState<T>(): KeyedState<T> {
  const values = signal<Record<string, T>>({});
  return {
    get: (key) => values()[key],
    set(key, value) {
      values.update((all) => ({ ...all, [key]: value }));
    },
    update(key, fn) {
      values.update((all) => {
        const next = fn(all[key]);
        if (next === undefined) {
          if (!(key in all)) return all;
          const { [key]: _gone, ...rest } = all;
          return rest;
        }
        return { ...all, [key]: next };
      });
    },
    delete(key) {
      values.update((all) => {
        if (!(key in all)) return all;
        const { [key]: _gone, ...rest } = all;
        return rest;
      });
    },
    clear() {
      values.set({});
    },
    keys: () => untracked(() => Object.keys(values())),
  };
}
