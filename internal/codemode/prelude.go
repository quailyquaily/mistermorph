package codemode

import "strings"

// prelude is the module the script runs in. The script becomes the body of userMain, which starts
// on the prelude's last line, so error positions are shifted by preludeLines. Host functions
// arrive once through __init and stay in this closure.
const prelude = `let host;
export function __init(h) { if (host) throw new TypeError("already initialized"); host = h; }
class ToolError extends Error { constructor(tool, message) { super(message); this.name = "ToolError"; this.tool = tool; } }
function plain(value, depth, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("cannot pass a non-finite number"); return value; }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") throw new TypeError("cannot pass a " + typeof value);
  if (depth >= ` + "64" + `) throw new TypeError("value nests deeper than 64 levels");
  if (seen.has(value)) throw new TypeError("cannot pass a value that contains itself");
  if (typeof value.toJSON === "function") return plain(value.toJSON(), depth, seen);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => { const v = plain(item, depth + 1, seen); return v === undefined ? null : v; });
    const out = {};
    for (const key of Object.keys(value)) { const v = plain(value[key], depth + 1, seen); if (v !== undefined) out[key] = v; }
    return out;
  } finally { seen.delete(value); }
}
function toJSON(value) { return JSON.stringify(plain(value, 0, new Set())); }
function show(value) { return typeof value === "string" ? value : toJSON(value); }
async function hostResult(promise, tool) {
  const r = await promise;
  if (!r.ok) throw new ToolError(tool, r.error);
  return r.value;
}
const tools = new Proxy(Object.freeze(Object.create(null)), {
  get(_target, name) {
    if (typeof name !== "string") return undefined;
    return (args) => {
      if (args === undefined) args = {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) return Promise.reject(new TypeError("tool arguments must be an object"));
      let json;
      try { json = toJSON(args); } catch (e) { return Promise.reject(e); }
      return hostResult(host.call(name, json), name);
    };
  },
  set() { return false; },
  defineProperty() { return false; },
  deleteProperty() { return false; },
});
async function searchTools(query, options) {
  const o = options === undefined ? {} : plain(options, 0, new Set());
  return JSON.parse(await hostResult(host.search(String(query), JSON.stringify(o)), "searchTools"));
}
async function describeTool(name) {
  return JSON.parse(await hostResult(host.describe(String(name)), "describeTool"));
}
function text(value) { if (value !== undefined) host.text(show(value)); }
const console = Object.freeze({ log: (...values) => host.text(values.map(show).join(" ")) });
export async function main() { const result = await userMain(); if (result !== undefined) text(result); }
async function userMain() {`

// preludeLines is how many lines come before the script's first line.
var preludeLines = strings.Count(prelude, "\n")

// preludeColumns is how many columns precede the script on its first line.
var preludeColumns = len(prelude) - strings.LastIndex(prelude, "\n") - 1
