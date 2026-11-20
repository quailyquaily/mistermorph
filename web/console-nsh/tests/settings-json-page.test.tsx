// Raw JSON settings on the real Settings page (tests/settings-json-dialog.test.tsx has the control
// on its own): the dialog's Apply only changes the section's draft, and the section's save bar
// sends it, with nothing else.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const OPENAI = "setting-llm.image.options.openai";

function agentSettings(values: Record<string, unknown> = {}) {
  return {
    config_revision: "rev-1",
    config_path: "/state/config.yaml",
    llm: { inference_provider: "openai", model: "gpt-5.2", current_profile: "", profiles: [], fallback_profiles: [] },
    tools: {},
    mcp: { servers: [] },
    config_values: {
      "llm.image.request_timeout": "2m0s",
      "llm.image.options.openai": { quality: "high" },
      "llm.image.options.gemini": {},
      "llm.image.options.cloudflare": {},
      ...values,
    },
    field_states: {},
  };
}

test("Models: OpenAI image options are edited in a dialog and saved by the section's save bar", async () => {
  const puts: any[] = [];
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    api: {
      "GET /settings/agent": { body: agentSettings() },
      "PUT /settings/agent": (request) => {
        puts.push(request.json);
        return { body: agentSettings({ ...request.json.config_changes }) };
      },
    },
  });
  await app.waitFor(`id:${OPENAI}-edit`);
  // Rows, not fields: the three provider options show their names and no JSON.
  expect(app.shows("label:Edit OpenAI options")).toBe(true);
  expect(app.shows("label:Edit Gemini options")).toBe(true);
  expect(app.shows("label:Edit Cloudflare options")).toBe(true);
  expect(app.texts().some((text) => text.includes('"quality"'))).toBe(false);
  expect(app.shows("id:settings-save-bar")).toBe(false);

  // A draft that is dropped leaves the section clean.
  await app.press(`id:${OPENAI}-edit`);
  await app.waitFor(`id:${OPENAI}-input`);
  expect(app.value(`id:${OPENAI}-input`)).toBe(JSON.stringify({ quality: "high" }, null, 2));
  await app.clear(`id:${OPENAI}-input`);
  await app.type(`id:${OPENAI}-input`, '{"quality":"low"}');
  await app.press(`id:${OPENAI}-dialog >> text:Cancel`);
  await app.waitFor(`id:${OPENAI}-input`, { state: "gone" });
  expect(app.shows("id:settings-save-bar")).toBe(false);

  // A draft that does not parse is kept in the dialog; nothing is sent.
  await app.press(`id:${OPENAI}-edit`);
  await app.waitFor(`id:${OPENAI}-input`);
  await app.clear(`id:${OPENAI}-input`);
  await app.type(`id:${OPENAI}-input`, '{"quality":');
  await app.press(`id:${OPENAI}-dialog-save`);
  await app.waitFor(`id:${OPENAI}-error`);
  expect(app.shows("id:settings-save-bar")).toBe(false);

  // Applied: an unsaved change of the section, not a request.
  await app.type(`id:${OPENAI}-input`, '"low"}');
  await app.press(`id:${OPENAI}-dialog-save`);
  await app.waitFor(`id:${OPENAI}-input`, { state: "gone" });
  await app.waitFor("id:settings-save-bar");
  expect(puts).toHaveLength(0);

  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => puts.length === 1);
  expect(puts[0].config_revision).toBe("rev-1");
  expect(puts[0].config_changes).toEqual({ "llm.image.options.openai": { quality: "low" } });
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  // The dialog opens on what was saved.
  await app.press(`id:${OPENAI}-edit`);
  await app.waitFor(`id:${OPENAI}-input`);
  expect(app.value(`id:${OPENAI}-input`)).toBe(JSON.stringify({ quality: "low" }, null, 2));
});

test("Models: a profile's HTTP headers are edited in a dialog and saved with the profile", async () => {
  const puts: any[] = [];
  const settings = agentSettings();
  settings.llm.profiles = [{ name: "cheap", inference_provider: "openai", model: "gpt-5-mini", headers: { "X-Team": "core" } }] as any;
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    api: {
      "GET /settings/agent": { body: settings },
      "PUT /settings/agent": (request) => {
        puts.push(request.json);
        return { body: settings };
      },
    },
  });
  await app.waitFor("id:settings-profile-cheap");
  await app.press("id:settings-profile-cheap");
  await app.waitFor("id:settings-profile-pane");
  await app.press("id:settings-profile-advanced");
  await app.waitFor("id:settings-profile-pane >> id:llm-headers-edit");
  // The header's value is not on the page.
  expect(app.texts().some((text) => text.includes("X-Team"))).toBe(false);
  await app.press("id:settings-profile-pane >> id:llm-headers-edit");
  await app.waitFor("id:llm-headers-input");
  expect(JSON.parse(String(app.value("id:llm-headers-input")))).toEqual({ "X-Team": "core" });
  // A list is not headers: kept in the dialog, the profile unchanged.
  await app.clear("id:llm-headers-input");
  await app.type("id:llm-headers-input", "[]");
  await app.press("id:llm-headers-dialog-save");
  await app.waitFor("text:HTTP headers must be a JSON object.");
  expect(app.shows("id:settings-save-bar")).toBe(false);
  await app.clear("id:llm-headers-input");
  await app.type("id:llm-headers-input", '{"X-Team":"infra"}');
  await app.press("id:llm-headers-dialog-save");
  await app.waitFor("id:llm-headers-input", { state: "gone" });
  // The profile's draft changed; the save bar saves it.
  await app.waitFor("id:settings-save-bar");
  expect(puts).toHaveLength(0);
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => puts.length > 0);
  const sent = JSON.stringify(puts);
  expect(sent).toContain('"headers":{"X-Team":"infra"}');
});
