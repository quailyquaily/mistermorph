import assert from "node:assert/strict";
import test from "node:test";
import { captureUnsavedScopes, mergeConfigUpdates, restoreUnsavedScopes } from "./settings-save.js";

function scopeFixture() {
  const state = {
    telegram: { allowed: "1", bot_token: "" },
    slack: { allowed: "T1", bot_token: "" },
    guard: { enabled: true },
  };
  const loaded = JSON.parse(JSON.stringify(state));
  const synced = [];
  const scopes = Object.keys(state).map((id) => ({
    id,
    dirty: () => JSON.stringify(state[id]) !== JSON.stringify(loaded[id]),
    slice: () => state[id],
    sync: () => synced.push(id),
  }));
  return { state, loaded, synced, scopes };
}

test("saving one scope keeps unsaved edits in the others", () => {
  const { state, loaded, synced, scopes } = scopeFixture();
  const secrets = new Set();
  state.telegram.allowed = "1\n2"; // being saved
  state.slack.allowed = "T1\nT2"; // unsaved, must survive
  state.slack.bot_token = "xoxb-new";
  secrets.add("slack.bot_token");

  const captured = captureUnsavedScopes(scopes, ["telegram"], secrets);
  assert.deepEqual(captured.map((item) => item.scope.id), ["slack"]);

  // The save response rewrites every scope and clears the secret markers.
  Object.assign(loaded.telegram, { allowed: "1\n2" });
  Object.assign(state.telegram, loaded.telegram);
  Object.assign(state.slack, loaded.slack);
  secrets.clear();

  restoreUnsavedScopes(captured, secrets);
  assert.equal(state.slack.allowed, "T1\nT2");
  assert.equal(state.slack.bot_token, "xoxb-new");
  assert.ok(secrets.has("slack.bot_token"));
  assert.deepEqual(synced, ["slack"]);
  assert.equal(state.telegram.allowed, "1\n2");
});

test("clean scopes and saved scopes are not captured", () => {
  const { state, scopes } = scopeFixture();
  state.guard.enabled = false;
  assert.deepEqual(captureUnsavedScopes(scopes, ["guard"]).length, 0);
  assert.deepEqual(captureUnsavedScopes(scopes, []).map((item) => item.scope.id), ["guard"]);
});

test("panel updates for one endpoint merge into a single update", () => {
  const merged = mergeConfigUpdates([
    { config_changes: { "heartbeat.enabled": true }, reset: [] },
    null,
    { config_changes: { "guard.dir_name": "g" }, reset: ["guard.audit.jsonl_path"] },
    { config_changes: {}, reset: ["guard.audit.jsonl_path"] },
  ]);
  assert.deepEqual(merged, {
    config_changes: { "heartbeat.enabled": true, "guard.dir_name": "g" },
    reset: ["guard.audit.jsonl_path"],
  });
});
