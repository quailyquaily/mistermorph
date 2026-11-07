import { batch, signal } from "nsh";

// An object whose fields are signals: reading `state.token` in a binding follows it, and
// `state.token = "x"` writes it. It keeps the shape of the Pinia stores the Vue console had, so
// the logic copied from it (lib/core) runs unchanged.
/**
 * @template {Record<string, any>} T
 * @template {Record<string, (...args: any[]) => any>} M
 * @param {T} initial
 * @param {M & ThisType<T & M>} [methods]
 * @returns {T & M}
 */
export function reactiveRecord(initial, methods = /** @type {M} */ ({})) {
  /** @type {Record<string, any>} */
  const fields = {};
  /** @type {any} */
  const state = {};
  for (const [key, value] of Object.entries(initial)) {
    fields[key] = signal(value, { equals: false });
    Object.defineProperty(state, key, {
      enumerable: true,
      get: () => fields[key](),
      set: (next) => fields[key].set(next),
    });
  }
  for (const [name, method] of Object.entries(methods)) {
    state[name] = (...args) => batch(() => method.apply(state, args));
  }
  return state;
}
