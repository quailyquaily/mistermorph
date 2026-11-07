// The image field and its adjust dialog (ImageUploadField.tsx), the connection test
// (SetupConnectionTestDialog.tsx) and the setup picker (SetupPickerDialog.tsx).
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

const PNG = { id: "f-1", name: "me.png", size: 2048, type: "image/png", preview: "asset:/assets/android-chrome-192x192.png" };

// Headless runs load no images (Image.getSize rejects), so the zoom and the cut of a loaded image
// are looked at in the app; here the dialog opens with the picked file and says it cannot load it.
test("Image: picking an image opens the adjust dialog for it", async () => {
  const { app, eventsNamed } = await openFixture({
    view: "image",
    params: { previewUrl: "asset:/assets/apple-touch-icon.png" },
    host: { "morph.file.pick": [PNG], "morph.file.release": null },
  });
  await app.press("id:image-upload-preview");
  await app.waitFor("id:image-upload-dialog");
  await app.press("Replace");
  await app.waitFor("id:image-adjust-dialog");
  expect(app.shows("id:image-upload-dialog")).toBe(false);
  expect(app.texts()).toContain("Avatar");
  expect(app.texts()).toContain("100%");
  const pick = app.host.calls().find((call) => call.name === "morph.file.pick");
  expect(pick?.data).toEqual({ accept: "image/png,image/jpeg,image/webp", multiple: false });
  await app.waitFor("Could not load image.");
  expect(app.enabled("id:image-adjust-zoom-in")).toBe(false);
  await app.press("Cancel");
  await app.waitFor("id:image-adjust-dialog", { state: "gone" });
  // Closing drops the picked file.
  expect(app.host.calls().some((call) => call.name === "morph.file.release")).toBe(true);
  expect(eventsNamed("image.save").length).toBe(0);
});

test("Image: a file of the wrong type or size is refused", async () => {
  const wrongType = await openFixture({
    view: "image",
    host: { "morph.file.pick": [{ ...PNG, type: "image/gif" }], "morph.file.release": null },
  });
  await wrongType.app.press("id:image-upload-preview");
  await wrongType.app.press("Replace");
  await wrongType.app.waitFor("Use a PNG, JPEG, or WebP image.");
  expect(wrongType.app.shows("id:image-adjust-dialog")).toBe(false);
  expect(wrongType.app.host.calls().some((call) => call.name === "morph.file.release")).toBe(true);

  const tooBig = await openFixture({
    view: "image",
    params: { maxBytes: 1000 },
    host: { "morph.file.pick": [PNG], "morph.file.release": null },
  });
  await tooBig.app.press("id:image-upload-preview");
  await tooBig.app.press("Replace");
  await tooBig.app.waitFor("Image must be 10 MB or smaller.");
});

test("Image: an image that cannot load says so and cannot be saved; Delete removes the current one", async () => {
  const { app, eventsNamed } = await openFixture({
    view: "image",
    params: { previewUrl: "asset:/assets/apple-touch-icon.png" },
    host: { "morph.file.pick": [{ ...PNG, preview: "" }], "morph.file.release": null },
  });
  await app.press("id:image-upload-preview");
  await app.press("Replace");
  await app.waitFor("Could not load image.");
  expect(app.enabled("Save")).toBe(false);
  await app.press("Cancel");
  await app.waitFor("id:image-adjust-dialog", { state: "gone" });
  await app.press("id:image-upload-preview");
  await app.press("id:image-upload-delete");
  await app.waitUntil(() => eventsNamed("image.delete").length === 1);
  expect(app.shows("id:image-upload-dialog")).toBe(false);
  // Without an image there is nothing to delete.
  await app.press("id:image-upload-preview");
  expect(app.enabled("id:image-upload-delete")).toBe(false);
});

test("Connection test: shows the running benchmarks, then the results with their raw responses", async () => {
  const { app, eventsNamed } = await openFixture({
    view: "connection",
    params: {
      benchmarks: [
        { id: "text_reply", ok: true, duration_ms: 1250, detail: "hello", raw_response: "Hello there" },
        { id: "tool_calling", ok: false, duration_ms: 12500, error: "no tool call", raw_response: "" },
      ],
    },
  });
  await app.press("Test connection");
  await app.waitFor("id:connection-test-dialog");
  expect(app.texts()).toContain("api.openai.com");
  expect(app.texts()).toContain("gpt-5.2");
  expect(app.texts()).toContain("JSON Response");
  expect(app.texts()).toContain("Judgments (decision route)");
  expect(app.texts().filter((text) => text === "Running").length).toBe(5);
  await app.host.send("morph.fixture.finish");
  await app.waitFor("LLM returned text correctly");
  expect(app.texts()).toContain("1.25s");
  expect(app.texts()).toContain("12.5s");
  expect(app.texts()).toContain("LLM cannot call tools");
  expect(app.shows("JSON Response")).toBe(false);
  await app.press("id:connection-test-toggle-text_reply");
  await app.waitFor("Hello there");
  await app.press("id:connection-test-toggle-tool_calling");
  await app.waitFor("No raw response was captured for this benchmark.");
  expect(app.shows("Hello there")).toBe(false);
  await app.press("Run Again");
  await app.waitUntil(() => eventsNamed("connection.retry").length === 2);
  await app.waitFor("Text Response");
  expect(app.shows("LLM returned text correctly")).toBe(false);
  await app.host.send("morph.fixture.finish");
  await app.waitFor("LLM returned text correctly");
  await app.press("text:Close");
  await app.waitFor("id:connection-test-dialog", { state: "gone" });
});

test("Connection test: an evaluate-only provider runs one benchmark; a failure shows the error", async () => {
  const { app } = await openFixture({ view: "connection", params: { provider: "typesafe" } });
  await app.press("Test connection");
  await app.waitFor("Judgments (decision route)");
  expect(app.shows("Text Response")).toBe(false);
  await app.host.send("morph.fixture.finish");
  await app.waitFor("connection refused");
  expect(app.shows("Judgments (decision route)")).toBe(false);
});

const MODELS = [
  { id: "openai/gpt-5.2", title: "openai/gpt-5.2", value: "openai/gpt-5.2", note: "" },
  { id: "openai/gpt-4o", title: "openai/gpt-4o", value: "openai/gpt-4o", note: "Superseded", verdict: "avoid" },
  { id: "anthropic/claude-opus-4", title: "anthropic/claude-opus-4", value: "anthropic/claude-opus-4", note: "" },
];

test("Picker: groups by vendor, filters, moves with the arrow keys, and picks with Enter", async () => {
  const { app, eventsNamed } = await openFixture({
    view: "picker",
    params: { items: MODELS, groupByPrefix: true, selectedValue: "anthropic/claude-opus-4" },
  });
  await app.press("Pick model");
  await app.waitFor("id:setup-picker-dialog");
  // Vendor groups, and the model to avoid under Others at the bottom.
  expect(app.texts()).toContain("OPENAI");
  expect(app.texts()).toContain("ANTHROPIC");
  expect(app.texts().indexOf("OTHERS")).toBeGreaterThan(app.texts().indexOf("ANTHROPIC"));
  expect(app.texts()).toContain("Superseded");
  await app.type("id:setup-picker-filter", "gpt");
  await app.waitFor("ANTHROPIC", { state: "gone" });
  await app.keyboard.press("down");
  await app.submit("id:setup-picker-filter");
  await app.waitUntil(() => eventsNamed("picker.select").length === 1);
  expect(eventsNamed("picker.select")[0].data.value).toBe("openai/gpt-4o");
  await app.waitFor("id:setup-picker-dialog", { state: "gone" });
  await app.waitFor("openai/gpt-4o");
});

test("Picker: a typed value that matches nothing is offered as its own; reopening clears the filter", async () => {
  const { app, eventsNamed } = await openFixture({ view: "picker", params: { items: MODELS } });
  await app.press("Pick model");
  await app.type("id:setup-picker-filter", "my-local-model");
  await app.waitFor("Use my-local-model");
  await app.press("label:Close");
  await app.waitFor("id:setup-picker-dialog", { state: "gone" });
  await app.press("Pick model");
  expect(app.value("id:setup-picker-filter")).toBe("");
  await app.type("id:setup-picker-filter", "my-local-model");
  await app.press("id:setup-picker-custom");
  await app.waitUntil(() => eventsNamed("picker.select").length === 1);
  expect(eventsNamed("picker.select")[0].data).toMatchObject({ value: "my-local-model", title: "my-local-model" });
});

test("Picker: an empty list says so, and an error shows", async () => {
  const empty = await openFixture({ view: "picker", params: { items: [] } });
  await empty.app.press("Pick model");
  await empty.app.waitFor("No models");
  const failed = await openFixture({ view: "picker", params: { items: [], error: "models failed to load" } });
  await failed.app.press("Pick model");
  await failed.app.waitFor("models failed to load");
  expect(failed.app.shows("No models")).toBe(false);
});
