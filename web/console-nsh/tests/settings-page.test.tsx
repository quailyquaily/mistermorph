// Settings: loading a section, editing it, the save bar (a save, a failed save, discarding), and
// leaving a section with unsaved changes.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

const PERSONA: Record<string, ApiHandler> = {
  "GET /proxy:/persona/files/identity.yaml": { body: { content: "name: Morph\nemoji: 🦊\ncreature: fox\nvibe: calm\n" } },
  "GET /proxy:/persona/files/soul.md": { body: { content: "# Soul\n\nBe kind.\n" } },
  "GET /proxy/download:/persona/avatar": { status: 404, body: { error: "not found" } },
};

const AGENT_SETTINGS = {
  config_revision: "rev-1",
  config_path: "/state/config.yaml",
  llm: { inference_provider: "openai", model: "gpt-5.2", profiles: [], fallback_profiles: [] },
  tools: {},
  mcp: { servers: [] },
  config_values: {},
  field_states: {},
};

test("the persona section loads the identity and soul", async () => {
  const { app, calls } = await openConsole({ location: "/e/default/settings", api: PERSONA });
  await app.waitFor("id:settings-persona");
  await app.waitUntil(() => app.value("id:settings-persona-name") === "Morph");
  expect(app.value("id:settings-persona-creature")).toBe("fox");
  expect(app.value("id:settings-persona-vibe")).toBe("calm");
  expect(calls.some((call) => call.uri === "/persona/files/soul.md")).toBe(true);
  // The section list beside it, with the selected section marked.
  expect(app.shows("id:settings-section-persona")).toBe(true);
  expect(app.shows("id:settings-section-agent")).toBe(true);
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("an edit shows the save bar, and Save writes identity.yaml", async () => {
  let saved = "";
  const { app } = await openConsole({
    location: "/e/default/settings",
    api: {
      ...PERSONA,
      "PUT /proxy:/persona/files/identity.yaml": (request) => {
        saved = String(request.json?.content || "");
        return { body: { ok: true } };
      },
    },
  });
  await app.waitUntil(() => app.value("id:settings-persona-name") === "Morph");
  await app.type("id:settings-persona-name", " Two");
  await app.waitFor("id:settings-save-bar");
  expect(app.shows("Unsaved changes (1)")).toBe(true);
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => saved !== "");
  expect(saved).toContain("name: Morph Two");
  // Fields it does not edit stay as they were.
  expect(saved).toContain("creature: fox");
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  await app.waitFor("Saved");
});

test("a failed save keeps the draft and says what was not saved", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings",
    api: {
      ...PERSONA,
      "PUT /proxy:/persona/files/identity.yaml": { status: 500, body: { error: "disk full" } },
    },
  });
  await app.waitUntil(() => app.value("id:settings-persona-name") === "Morph");
  await app.clear("id:settings-persona-name");
  await app.type("id:settings-persona-name", "Nova");
  await app.press("id:settings-save-bar-save");
  await app.waitFor("disk full");
  await app.waitFor("id:settings-save-bar-failed");
  expect(app.value("id:settings-persona-name")).toBe("Nova");
});

test("leaving a section with unsaved changes asks first; Keep editing stays, Discard leaves", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/settings",
    api: { ...PERSONA, "GET /settings/agent": { body: AGENT_SETTINGS } },
  });
  await app.waitUntil(() => app.value("id:settings-persona-name") === "Morph");
  await app.type("id:settings-persona-name", " Edited");
  await app.waitFor("id:settings-save-bar");

  await app.press("id:settings-section-agent");
  await app.waitFor("Unsaved changes");
  await app.waitFor("id:dialog-action-cancel");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:dialog-action-cancel", { state: "gone" });
  expect(app.shows("id:settings-persona")).toBe(true);
  expect(app.value("id:settings-persona-name")).toBe("Morph Edited");
  expect(calls.some((call) => call.path === "/settings/agent")).toBe(false);

  await app.press("id:settings-section-agent");
  await app.waitFor("id:dialog-action-confirm");
  await app.press("id:dialog-action-confirm");
  await app.waitFor("id:settings-agent");
  await app.waitUntil(() => calls.some((call) => call.path === "/settings/agent"));
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("a section that fails to load says so", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    api: { "GET /settings/agent": { status: 500, body: { error: "config unreadable" } } },
  });
  await app.waitFor("id:settings-agent");
  await app.waitFor("config unreadable");
});
