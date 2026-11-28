import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProviderModel,
  DEFAULT_PROVIDER_MODELS,
  initialProviderModel,
  lastProviderModel,
  modelIDsFromPayload,
  suggestedProviderModel,
} from "./provider-models.js";

test("a provider change takes the last model set for it, else its default, else nothing", () => {
  const last = { openai: "gpt-old", kimi: "  " };
  assert.deepEqual(initialProviderModel("OpenAI", last), { model: "gpt-old", remembered: true });
  assert.deepEqual(initialProviderModel("anthropic", last), { model: "claude-sonnet-5-5", remembered: false });
  assert.deepEqual(initialProviderModel("kimi", last), { model: "kimi-k3", remembered: false });
  // No default: the user chooses. Codex's default is its own list's first.
  assert.deepEqual(initialProviderModel("openrouter", last), { model: "", remembered: false });
  assert.deepEqual(initialProviderModel("openai_codex", null), { model: "", remembered: false });
  assert.equal(lastProviderModel(undefined, "openai"), "");
  assert.equal(DEFAULT_PROVIDER_MODELS.openai, "gpt-6.2-sol");
  assert.equal(DEFAULT_PROVIDER_MODELS.deepseek, "deepseek-v4-flash");
});

test("the list's suggestion is the default when listed; Codex's is the first listed", () => {
  assert.equal(suggestedProviderModel("openai", ["gpt-x", "gpt-6.2-sol"]), "gpt-6.2-sol");
  assert.equal(suggestedProviderModel("openai", ["gpt-x"]), "");
  assert.equal(suggestedProviderModel("openai_codex", ["gpt-first", "gpt-second"]), "gpt-first");
  assert.equal(suggestedProviderModel("openrouter", ["a/b"]), "");
});

test("a remembered model is kept while listed, and reported when it is gone", () => {
  const ids = ["gpt-6.2-sol", "gpt-old"];
  assert.deepEqual(checkProviderModel({ provider: "openai", model: "gpt-old", remembered: true, ids }), {});
  assert.deepEqual(checkProviderModel({ provider: "openai", model: "gpt-gone", remembered: true, ids }), {
    missing: { model: "gpt-gone", suggestion: "gpt-6.2-sol" },
  });
  // Nothing to suggest: the dialog sends the user to choose.
  assert.deepEqual(checkProviderModel({ provider: "openrouter", model: "x/gone", remembered: true, ids: ["a/b"] }), {
    missing: { model: "x/gone", suggestion: "" },
  });
  // No list (not signed in, a failed read) says nothing.
  assert.deepEqual(checkProviderModel({ provider: "openai", model: "gpt-gone", remembered: true, ids: [] }), {});
});

test("without a remembered model the field takes the list's suggestion", () => {
  assert.deepEqual(checkProviderModel({ provider: "openai_codex", model: "", remembered: false, ids: ["gpt-first", "b"] }), { model: "gpt-first" });
  // The default was filled in already and the list has it: nothing changes.
  assert.deepEqual(checkProviderModel({ provider: "openai", model: "gpt-6.2-sol", remembered: false, ids: ["gpt-6.2-sol"] }), {});
  // The default is not offered by this account: the user chooses.
  assert.deepEqual(checkProviderModel({ provider: "openai", model: "gpt-6.2-sol", remembered: false, ids: ["gpt-x"] }), { model: "" });
});

test("model ids come from the answer's items, in order", () => {
  assert.deepEqual(modelIDsFromPayload({ items: ["b", " a ", ""] }), ["b", "a"]);
  assert.deepEqual(modelIDsFromPayload({ models: [{ id: "m1" }, { id: "m2", created: 3 }] }), ["m1", "m2"]);
  assert.deepEqual(modelIDsFromPayload(null), []);
});
