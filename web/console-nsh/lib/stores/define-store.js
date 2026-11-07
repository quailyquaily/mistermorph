import { computed } from "nsh";
import { reactiveRecord } from "./reactive-record.js";

// The part of Pinia's defineStore the Vue console used: state, actions and getters, one
// instance per store. `useStore()` returns it, with or without an argument.
/**
 * @template {Record<string, any>} S
 * @template {Record<string, (...args: any[]) => any>} A
 * @template {Record<string, (state: any) => any>} G
 * @param {string} _id
 * @param {{ state?: () => S, actions?: A & ThisType<S & A & { [K in keyof G]: ReturnType<G[K]> }>, getters?: G }} options
 * @returns {() => S & A & { [K in keyof G]: ReturnType<G[K]> }}
 */
export function defineStore(_id, options) {
  /** @type {any} */
  let instance = null;
  return function useStore() {
    if (instance) {
      return instance;
    }
    instance = reactiveRecord(options.state ? options.state() : {}, options.actions || {});
    for (const [name, getter] of Object.entries(options.getters || {})) {
      const value = computed(() => getter.call(instance, instance));
      Object.defineProperty(instance, name, { enumerable: true, get: () => value() });
    }
    return instance;
  };
}
