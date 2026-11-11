// The "···" menus at the top right of Settings: the Models card's (the default model's advanced
// settings, context compaction, the benchmark) and a channel pane's. Their trigger used to be a
// Button, whose own press kept nsh's Menu from ever opening.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

function agentSettings(overrides: Record<string, unknown> = {}) {
  return {
    config_revision: "rev-1",
    config_path: "/state/config.yaml",
    llm: {
      inference_provider: "openai",
      model: "gpt-5.2",
      current_profile: "",
      profiles: [{ name: "cheap", inference_provider: "openai", model: "gpt-5-mini" }],
      fallback_profiles: [],
    },
    tools: {},
    mcp: { servers: [] },
    config_values: { "llm.cache_key_prefix": "" },
    field_states: {},
    ...overrides,
  };
}

function consoleSettings() {
  return {
    config_revision: "rev-1",
    managed_runtimes: [],
    telegram: { bot_token: "", allowed_chat_ids: [], group_trigger_mode: "smart" },
    slack: {},
    discord: {},
    guard: { enabled: true },
    secret_fields: {},
    env_managed: {},
    config_values: {},
    field_states: {},
    endpoints: [],
    auth_profiles: [],
  };
}

const MODELS_MENU = ["Advanced settings", "Context compaction", "Benchmark"];

function menuLabels(app: { texts(): string[] }) {
  return MODELS_MENU.filter((label) => app.texts().includes(label));
}

test("Models: the top-right menu opens, and its Advanced settings save the default model's", async () => {
  let body: any = null;
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    api: {
      "GET /settings/agent": { body: agentSettings() },
      "PUT /settings/agent": (request) => {
        body = request.json;
        return { body: agentSettings({ config_revision: "rev-2", config_values: { "llm.cache_key_prefix": "morph-" } }) };
      },
    },
  });
  await app.waitFor("id:settings-profile-cheap");
  expect(app.count("role:menuitem")).toBe(0);
  await app.press("id:settings-llm-menu");
  await app.waitFor("role:menuitem[Advanced settings]");
  expect(menuLabels(app)).toEqual(MODELS_MENU);
  await app.press("role:menuitem[Advanced settings]");
  // Choosing closes the menu and opens the default model's advanced settings.
  await app.waitFor("id:settings-advanced");
  await app.waitFor("role:menuitem", { state: "gone" });
  expect(app.texts()).toContain("Default model · Advanced settings");
  await app.type("label:Cache key prefix", "morph-");
  await app.press("id:settings-advanced-save");
  await app.waitUntil(() => body !== null);
  expect(body.config_revision).toBe("rev-1");
  expect(body.config_changes).toEqual({ "llm.cache_key_prefix": "morph-" });
  await app.waitFor("id:settings-advanced", { state: "gone" });
  // The menu opens again after the save.
  await app.press("id:settings-llm-menu");
  await app.waitFor("role:menuitem[Context compaction]");
});

test("Models: a second press on the trigger closes the menu without choosing", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/settings/agent",
    api: { "GET /settings/agent": { body: agentSettings() } },
  });
  await app.waitFor("id:settings-profile-cheap");
  await app.press("id:settings-llm-menu");
  await app.waitFor("role:menuitem[Advanced settings]");
  await app.press("id:settings-llm-menu");
  await app.waitFor("role:menuitem", { state: "gone" });
  expect(app.shows("id:settings-advanced")).toBe(false);
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

test("Models: on an Android phone the menu opens as a sheet and its items work", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    platform: "android",
    api: { "GET /settings/agent": { body: agentSettings() } },
  });
  await app.waitFor("id:settings-llm-menu");
  await app.press("id:settings-llm-menu");
  await app.waitFor("role:menuitem[Context compaction]");
  expect(menuLabels(app)).toEqual(MODELS_MENU);
  await app.press("role:menuitem[Context compaction]");
  await app.waitFor("id:settings-advanced");
  expect(app.texts()).toContain("Context compaction · Advanced settings");
});

test("Channels: a channel pane's top-right menu opens its advanced settings", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/channels",
    api: { "GET /settings/console": { body: consoleSettings() } },
  });
  await app.waitFor("id:settings-channel-telegram");
  await app.press("id:settings-channel-telegram");
  await app.waitFor("id:settings-channel-pane");
  await app.press("id:settings-channel-menu");
  await app.waitFor("role:menuitem[Advanced settings]");
  await app.press("role:menuitem[Advanced settings]");
  await app.waitFor("id:settings-advanced");
});
