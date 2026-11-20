// Raw JSON settings (components/settings/SettingJson): a compact row with an edit button, and a
// dialog that edits a draft of the JSON. The row never shows the value; Cancel, the backdrop (pressed
// on the phone, where the paper leaves its middle free) and Escape drop the draft; Apply checks it and changes the form's draft, which the form's own Save
// persists. In the config panel (OpenAI, Gemini, Cloudflare options, a rows field the rows cannot
// show), the auth profiles' advanced bindings and the LLM form's HTTP headers.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

const OPENAI = "setting-llm.image.options.openai";
const GEMINI = "setting-llm.image.options.gemini";
const CLOUDFLARE = "setting-llm.image.options.cloudflare";
const HEADERS = "setting-llm.headers-json";
const OPENAI_TEXT = JSON.stringify({ quality: "high", api_token: "sk-secret-1" }, null, 2);

/** Opens a row's dialog and waits for its field. */
async function edit(app: App, id: string) {
  await app.press(`id:${id}-edit`);
  await app.waitFor(`id:${id}-input`);
}

/** Replaces the dialog's draft. */
async function write(app: App, id: string, text: string) {
  await app.clear(`id:${id}-input`);
  if (text) await app.type(`id:${id}-input`, text);
}

const apply = (app: App, id: string) => app.press(`id:${id}-dialog-save`);
const closed = (app: App, id: string) => app.waitUntil(() => !app.shows(`id:${id}-input`));

async function openPanel(options: { width?: number; height?: number } = {}) {
  const { app } = await openFixture("/json", {}, options);
  await app.waitFor(`id:${OPENAI}-edit`);
  return app;
}

test("a json setting is a labeled row with an edit button, and shows no value", async () => {
  const app = await openPanel();
  const texts = app.texts();
  expect(texts).toContain("OpenAI options");
  // Its description stays on the row.
  expect(texts).toContain("Extra fields for image requests.");
  // Nothing of the value: not its JSON, not a key, not the secret in it.
  expect(texts.some((text) => /sk-secret-1|api_token|quality|steps|X-Nested/.test(text))).toBe(false);
  // No field holds it either until the dialog opens.
  expect(app.shows(`id:${OPENAI}-input`)).toBe(false);
  // The button is named for what it edits.
  expect(app.shows("label:Edit OpenAI options")).toBe(true);
  expect(app.shows("label:Edit Gemini options")).toBe(true);
  // Other multiline settings stay fields on the page.
  expect(app.value("label:Allowed tools")).toBe("bash");
});

test("the dialog starts from the setting; Cancel and Escape drop the draft", async () => {
  const app = await openPanel();
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe(OPENAI_TEXT);
  expect(app.shows(`id:${OPENAI}-dialog >> text:Apply`)).toBe(true);

  await write(app, OPENAI, '{"quality":"low"}');
  await app.press(`id:${OPENAI}-dialog >> text:Cancel`);
  await closed(app, OPENAI);
  expect(out(app, "dirty")).toBe("false");
  // Opened again it is the setting, not the draft that was dropped.
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe(OPENAI_TEXT);

  // Tab leaves the field for the dialog's buttons; Escape there drops the draft. (Headless, Escape
  // does not reach a focused field: in the field it is checked in a browser.)
  await write(app, OPENAI, "{}");
  await app.keyboard.press("Tab");
  await app.keyboard.press("Escape");
  await closed(app, OPENAI);
  expect(out(app, "dirty")).toBe("false");
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe(OPENAI_TEXT);
  // Nothing was saved along the way.
  expect(out(app, "saved")).toBe("null");
});

test("the dialog's field has the focus when it opens", async () => {
  const app = await openPanel();
  await edit(app, GEMINI);
  await app.keyboard.press("x");
  await app.waitUntil(() => String(app.value(`id:${GEMINI}-input`)).includes("x"));
});

test("JSON that does not parse stays in the dialog with the error, and changes nothing", async () => {
  const app = await openPanel();
  await edit(app, OPENAI);
  await write(app, OPENAI, '{"quality": ');
  await apply(app, OPENAI);
  await app.waitFor(`id:${OPENAI}-error`);
  expect(app.shows("text:/^OpenAI options must be valid JSON/")).toBe(true);
  // The draft is kept as typed, the dialog is still open, the panel has no change.
  expect(app.value(`id:${OPENAI}-input`)).toBe('{"quality": ');
  expect(out(app, "dirty")).toBe("false");
  expect(app.enabled("id:panel-save")).toBe(false);

  // An empty draft is not JSON for the panel's fields, as its Save had it.
  await write(app, OPENAI, "");
  await apply(app, OPENAI);
  await app.waitFor("text:OpenAI options must be valid JSON: it is empty.");
  expect(out(app, "dirty")).toBe("false");

  // Put right, it applies.
  await write(app, OPENAI, '{"quality":"low"}');
  await apply(app, OPENAI);
  await closed(app, OPENAI);
  await app.waitUntil(() => out(app, "dirty") === "true");
});

test("Apply changes the panel's draft only; the panel's Save sends it", async () => {
  const app = await openPanel();
  await edit(app, OPENAI);
  await write(app, OPENAI, '{"quality":"low","n":2}');
  await apply(app, OPENAI);
  await closed(app, OPENAI);
  await app.waitUntil(() => out(app, "dirty") === "true");
  // Applied, not saved; and the row still shows no value.
  expect(out(app, "saved")).toBe("null");
  expect(app.texts().some((text) => text.includes('"low"') && !text.startsWith("saved="))).toBe(false);
  // The dialog opens on what was applied.
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe('{"quality":"low","n":2}');
  await app.press(`id:${OPENAI}-dialog >> text:Cancel`);
  await closed(app, OPENAI);

  await app.press("id:panel-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  // Only the field that changed.
  expect(JSON.parse(out(app, "saved"))).toEqual({
    config_changes: { "llm.image.options.openai": { quality: "low", n: 2 } },
    reset: [],
  });
});

test("applying a draft that is the setting's own text changes nothing", async () => {
  const app = await openPanel();
  await edit(app, OPENAI);
  await apply(app, OPENAI);
  await closed(app, OPENAI);
  expect(out(app, "dirty")).toBe("false");
});

test("a setting that is not set opens on its unset value and takes a first value", async () => {
  const app = await openPanel();
  await edit(app, GEMINI);
  expect(app.value(`id:${GEMINI}-input`)).toBe("null");
  await write(app, GEMINI, '{"aspect_ratio":"16:9"}');
  await apply(app, GEMINI);
  await closed(app, GEMINI);
  await app.press("id:panel-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  expect(JSON.parse(out(app, "saved")).config_changes).toEqual({ "llm.image.options.gemini": { aspect_ratio: "16:9" } });
});

test("a read-only setting cannot be opened, and a dialog cannot apply once its panel is busy", async () => {
  const app = await openPanel();
  expect(app.enabled(`id:${CLOUDFLARE}-edit`)).toBe(false);
  expect(app.shows("text:Managed by a command-line flag")).toBe(true);
  await app.press(`id:${CLOUDFLARE}-edit`).catch(() => undefined);
  await app.wait(200);
  expect(app.shows(`id:${CLOUDFLARE}-input`)).toBe(false);

  await edit(app, OPENAI);
  await write(app, OPENAI, '{"quality":"low"}');
  await app.press("id:busy");
  await app.waitUntil(() => !app.enabled(`id:${OPENAI}-dialog-save`));
  await app.press(`id:${OPENAI}-dialog-save`).catch(() => undefined);
  await app.wait(200);
  expect(out(app, "dirty")).toBe("false");
  expect(app.shows(`id:${OPENAI}-input`)).toBe(true);
});

test("a rows setting the rows cannot show is edited as JSON in the dialog", async () => {
  const app = await openPanel();
  await app.waitFor("text:This value cannot be shown as rows. Edit it as JSON.");
  expect(app.shows("label:Edit HTTP headers")).toBe(true);
  await edit(app, HEADERS);
  expect(app.value(`id:${HEADERS}-input`)).toBe(JSON.stringify({ "X-Nested": { a: 1 } }, null, 2));
  await write(app, HEADERS, '{"X-Team": ');
  await apply(app, HEADERS);
  await app.waitFor("text:/^HTTP headers must be valid JSON/");
  await write(app, HEADERS, '{"X-Team":"core"}');
  await apply(app, HEADERS);
  await closed(app, HEADERS);
  // A map of strings: the rows take over.
  await app.waitUntil(() => !app.shows("text:This value cannot be shown as rows. Edit it as JSON."));
  await app.press("id:panel-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  expect(JSON.parse(out(app, "saved")).config_changes).toEqual({ "llm.headers": { "X-Team": "core" } });
});

test("on a phone the dialog is the same flow", async () => {
  const app = await openPanel({ width: 390, height: 844 });
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe(OPENAI_TEXT);
  await write(app, OPENAI, "nope");
  await apply(app, OPENAI);
  await app.waitFor(`id:${OPENAI}-error`);
  expect(app.value(`id:${OPENAI}-input`)).toBe("nope");
  await write(app, OPENAI, '{"quality":"low"}');
  await apply(app, OPENAI);
  await closed(app, OPENAI);
  await app.waitUntil(() => out(app, "dirty") === "true");
  await edit(app, OPENAI);
  await write(app, OPENAI, "{}");
  await app.press(`id:${OPENAI}-dialog-scrim`);
  await closed(app, OPENAI);
  await edit(app, OPENAI);
  expect(app.value(`id:${OPENAI}-input`)).toBe('{"quality":"low"}');
});

const BINDINGS = "auth-profile-bindings-1";

test("auth profiles: advanced bindings are edited in the dialog and saved with the profiles", async () => {
  const { app } = await openFixture("/auth");
  await app.waitFor("text:Advanced bindings (JSON)");
  expect(app.shows("label:Edit Advanced bindings 1")).toBe(true);
  // The row shows no binding; the structured fields beside it are as before.
  expect(app.texts().some((text) => text.includes('"inject"'))).toBe(false);
  await edit(app, BINDINGS);
  expect(JSON.parse(String(app.value(`id:${BINDINGS}-input`)))).toEqual({
    url_fetch: { inject: { location: "header", name: "Authorization", format: "bearer" } },
  });
  // Bindings are an object: a list is refused, and kept in the dialog.
  await write(app, BINDINGS, "[1, 2]");
  await apply(app, BINDINGS);
  await app.waitFor("text:Bindings must be a JSON object.");
  expect(app.value(`id:${BINDINGS}-input`)).toBe("[1, 2]");
  // Dropped, the bindings are untouched.
  await app.press(`id:${BINDINGS}-dialog >> text:Cancel`);
  await closed(app, BINDINGS);
  await edit(app, BINDINGS);
  expect(app.value(`id:${BINDINGS}-input`)).toContain("Authorization");

  await write(app, BINDINGS, '{"url_fetch":{"inject":{"location":"header","name":"X-Key","format":"raw"}}}');
  await apply(app, BINDINGS);
  await closed(app, BINDINGS);
  // Applied to the draft (the structured field follows), saved only by Save.
  await app.waitUntil(() => app.value("id:auth >> label:Header name") === "X-Key");
  expect(out(app, "saved")).toBe("null");
  await app.press("id:auth-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  const saved = JSON.parse(out(app, "saved"));
  expect(saved[0].bindings).toEqual({ url_fetch: { inject: { location: "header", name: "X-Key", format: "raw" } } });
  expect(saved[0].name).toBe("github");
});

test("auth profiles: empty bindings stay no bindings", async () => {
  const { app } = await openFixture("/auth");
  await app.waitFor("text:Advanced bindings (JSON)");
  await edit(app, BINDINGS);
  await write(app, BINDINGS, "");
  await apply(app, BINDINGS);
  await closed(app, BINDINGS);
  await app.press("id:auth-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  expect(JSON.parse(out(app, "saved"))[0].bindings).toEqual({});
});

const LLM_HEADERS = "llm-headers";
const events = (app: App) => JSON.parse(out(app, "events") || "[]") as string[];

test("llm form: HTTP headers are edited in the dialog and reported to the form on Apply", async () => {
  const { app } = await openFixture("/llm");
  await app.waitFor(`id:${LLM_HEADERS}-edit`);
  expect(app.shows("label:Edit HTTP headers")).toBe(true);
  // Not set yet: the dialog opens empty.
  await edit(app, LLM_HEADERS);
  expect(app.value(`id:${LLM_HEADERS}-input`)).toBe("");
  // Headers are an object, as the profile's check has it.
  await write(app, LLM_HEADERS, '["X-Team"]');
  await apply(app, LLM_HEADERS);
  await app.waitFor("text:HTTP headers must be a JSON object.");
  await write(app, LLM_HEADERS, '{"X-Team": ');
  await apply(app, LLM_HEADERS);
  await app.waitFor("text:/^HTTP headers must be valid JSON/");
  // Typing, failing and dropping told the form nothing.
  await app.keyboard.press("Tab");
  await app.keyboard.press("Escape");
  await closed(app, LLM_HEADERS);
  expect(events(app).some((event) => event.startsWith("headers_text="))).toBe(false);

  await edit(app, LLM_HEADERS);
  expect(app.value(`id:${LLM_HEADERS}-input`)).toBe("");
  await write(app, LLM_HEADERS, '{"X-Team":"core"}');
  await apply(app, LLM_HEADERS);
  await closed(app, LLM_HEADERS);
  // One change of that one field.
  expect(events(app)).toEqual(['headers_text={"X-Team":"core"}']);
  // The row shows none of it.
  expect(app.texts().some((text) => text.includes("X-Team") && !text.startsWith("events="))).toBe(false);

  // Emptied, it is no headers again.
  await edit(app, LLM_HEADERS);
  expect(app.value(`id:${LLM_HEADERS}-input`)).toBe('{"X-Team":"core"}');
  await write(app, LLM_HEADERS, "");
  await apply(app, LLM_HEADERS);
  await closed(app, LLM_HEADERS);
  expect(events(app)).toEqual(['headers_text={"X-Team":"core"}', "headers_text="]);
});
