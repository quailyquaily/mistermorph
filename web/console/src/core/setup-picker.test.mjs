import assert from "node:assert/strict";
import test from "node:test";

import { buildPickerRows, highlightParts, modelPickerItemsFromPayload } from "./setup-picker.js";

const models = ["openai/gpt-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5", "local-model"].map((value) => ({
  id: value,
  title: value,
  value,
}));

test("model rows group by vendor in the order of their first model, with the vendor dropped from each row", () => {
  const rows = buildPickerRows(models, { groupByPrefix: true });
  assert.deepEqual(rows.groups.map((group) => group.title), ["openai", "anthropic", ""]);
  assert.deepEqual(rows.groups[1].items.map((row) => row.label), ["claude-sonnet-5", "claude-haiku-4-5"]);
  assert.deepEqual(rows.groups.flatMap((group) => group.items.map((row) => row.index)), [0, 1, 2, 3]);
  assert.equal(rows.custom, null);
});

test("values without a vendor stay one plain list", () => {
  const rows = buildPickerRows([{ title: "gpt-5", value: "gpt-5" }], { groupByPrefix: true });
  assert.equal(rows.groups.length, 1);
  assert.equal(rows.groups[0].title, "");
});

test("the filter narrows the rows and offers the typed name when nothing matches exactly", () => {
  const rows = buildPickerRows(models, { query: "sonnet", groupByPrefix: true, allowCustom: true });
  assert.deepEqual(rows.groups.map((group) => group.title), ["anthropic"]);
  assert.deepEqual(rows.custom, { index: 1, value: "sonnet" });
  const exact = buildPickerRows(models, { query: "local-model", groupByPrefix: true, allowCustom: true });
  assert.equal(exact.custom, null);
  const none = buildPickerRows(models, { query: "zzz", allowCustom: false });
  assert.equal(none.groups.length, 0);
  assert.equal(none.custom, null);
});

test("highlightParts marks every match, ignoring case", () => {
  assert.deepEqual(highlightParts("Claude-claude", "CLAUDE"), [
    { text: "Claude", match: true },
    { text: "-", match: false },
    { text: "claude", match: true },
  ]);
  assert.deepEqual(highlightParts("gpt-5", ""), [{ text: "gpt-5", match: false }]);
});

test("model items keep the newest-first order and keep dates for the rules, not for display", () => {
  const items = modelPickerItemsFromPayload({
    items: ["b", "a"],
    models: [{ id: "b", created: 1754006400 }, { id: "a" }],
  });
  assert.deepEqual(items.map((item) => item.value), ["b", "a"]);
  assert.equal(items[0].created, 1754006400);
  assert.equal(items[0].meta, undefined);
  assert.deepEqual(modelPickerItemsFromPayload({ items: ["x"] }).map((item) => item.value), ["x"]);
});

test("models to avoid move to Legacy models at the bottom; recommended ones stay in their group", () => {
  const items = [
    { value: "openai/gpt-5", verdict: "recommended" },
    { value: "anthropic/claude-opus-4-7", verdict: "avoid" },
    { value: "anthropic/claude-sonnet-5" },
  ].map((item) => ({ ...item, id: item.value, title: item.value }));
  const rows = buildPickerRows(items, { groupByPrefix: true, labels: { avoid: "A" } });
  assert.deepEqual(rows.groups.map((group) => group.title), ["openai", "anthropic", "A"]);
  assert.deepEqual(rows.groups.flatMap((group) => group.items.map((row) => row.index)), [0, 1, 2]);
  const plain = buildPickerRows([{ value: "x", verdict: "avoid" }, { value: "y" }].map((item) => ({ ...item, title: item.value })), {
    labels: { avoid: "A", other: "O" },
  });
  assert.deepEqual(plain.groups.map((group) => group.title), ["O", "A"]);
});

test("model items explain, in the UI language, why the rules moved a model to Others", () => {
  const items = modelPickerItemsFromPayload(
    { models: [{ id: "claude-sonnet-5-5", created: 1790000000 }, { id: "claude-sonnet-5", created: 1780000000 }, { id: "text-embedding-3-small" }] },
    "zh-CN",
  );
  const byValue = Object.fromEntries(items.map((item) => [item.value, item]));
  assert.equal(byValue["claude-sonnet-5"].verdict, "avoid");
  assert.equal(byValue["claude-sonnet-5"].note, "有新版本了：claude-sonnet-5-5");
  assert.equal(byValue["text-embedding-3-small"].note, "不是聊天模型，这里用不了。");
  assert.equal(byValue["claude-sonnet-5-5"].verdict, "recommended");
});
