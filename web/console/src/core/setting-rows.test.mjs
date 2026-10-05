import assert from "node:assert/strict";
import test from "node:test";

import { createConfigDraft, isListenAddress } from "./config-fields.js";
import { ADMIN_PLATFORM_OPTIONS } from "./config-options.js";
import { ROW_MODES } from "./setting-rows.js";

// Opening an editor and saving without edits must reproduce the draft text exactly, or the
// field would show as changed.
function roundTrip(mode, value, type, platforms = []) {
  const field = { path: "x", type };
  const draft = createConfigDraft({ x: value }, [field]).x;
  const rows = ROW_MODES[mode].parse(draft, platforms);
  assert.ok(Array.isArray(rows), `${mode} parses ${draft}`);
  assert.equal(ROW_MODES[mode].serialize(rows), draft, mode);
  return rows;
}

test("row editors round-trip the draft text unchanged", () => {
  roundTrip("list", ["/etc", "~/.ssh"], "string_list");
  roundTrip("list", [], "string_list");
  roundTrip("map", { "X-Team": "core", Authorization: "Bearer ${TOKEN}" }, "json");
  roundTrip("map", {}, "json");
  roundTrip("env", ["OPENAI_API_BASE", { name: "MY_FIXED_TOKEN", value: "abc" }], "json");
  roundTrip("env", [], "json");
  roundTrip("patterns", [{ name: "jwt", re: "eyJ[a-zA-Z0-9_-]+" }], "json");
  const rows = roundTrip(
    "identities",
    ["tg:@admin", "slack:T123:U234", "mixin:773e5e77-4107-45c2-b648-8fc722ed77f5"],
    "string_list",
    ADMIN_PLATFORM_OPTIONS,
  );
  assert.deepEqual(rows[1], { platform: "slack", id: "T123:U234" });
});

test("row editors drop blank rows and keep env values only when set", () => {
  assert.equal(ROW_MODES.list.serialize([{ value: " /tmp " }, { value: "" }]), "/tmp");
  assert.equal(
    ROW_MODES.env.serialize([{ name: "A", value: "" }, { name: "B", value: "1" }, { name: " ", value: "x" }]),
    JSON.stringify(["A", { name: "B", value: "1" }], null, 2),
  );
  assert.equal(ROW_MODES.map.serialize([{ name: "", value: "ignored" }]), "{}");
  assert.equal(ROW_MODES.identities.serialize([{ platform: "tg", id: " @me " }, { platform: "tg", id: "" }]), "tg:@me");
});

test("row editors leave unreadable JSON to the raw editor", () => {
  assert.equal(ROW_MODES.map.parse("[1, 2]"), null);
  assert.equal(ROW_MODES.map.parse(JSON.stringify({ not: ["a map of strings"] })), null);
  assert.equal(ROW_MODES.env.parse("{not json"), null);
});

test("patterns flag invalid regular expressions", () => {
  assert.equal(ROW_MODES.patterns.rowError({ name: "a", re: "[a-z]+" }), "");
  assert.notEqual(ROW_MODES.patterns.rowError({ name: "a", re: "[a-z" }), "");
});

test("isListenAddress accepts host:port forms only", () => {
  for (const ok of ["127.0.0.1:9080", ":8080", "localhost:80", "[::1]:9080", "0.0.0.0:65535"]) {
    assert.equal(isListenAddress(ok), true, ok);
  }
  for (const bad of ["9080", "127.0.0.1", "host:port", "127.0.0.1:70000", "a b:80"]) {
    assert.equal(isListenAddress(bad), false, bad);
  }
});
