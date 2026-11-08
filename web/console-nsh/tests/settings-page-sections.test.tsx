// Settings sections: tools, channels, security, models, search, the restart banner, phones.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

const PERSONA: Record<string, ApiHandler> = {
  "GET /proxy:/persona/files/identity.yaml": { body: { content: "name: Morph\n" } },
  "GET /proxy:/persona/files/soul.md": { body: { content: "# Soul\n" } },
  "GET /proxy/download:/persona/avatar": { status: 404, body: { error: "not found" } },
};

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
    tools: { write_file: { enabled: true }, bash: { enabled: true }, web_search: { enabled: false } },
    mcp: { servers: [] },
    config_values: {},
    field_states: {},
    ...overrides,
  };
}

function consoleSettings(overrides: Record<string, unknown> = {}) {
  return {
    config_revision: "rev-1",
    managed_runtimes: ["telegram"],
    telegram: { bot_token: "", allowed_chat_ids: ["42"], group_trigger_mode: "smart" },
    slack: {},
    discord: {},
    guard: { enabled: true, network: { url_fetch: { allowed_url_prefixes: ["https://"] } } },
    secret_fields: { telegram: { bot_token: { configured: true, editable: true } } },
    env_managed: {},
    config_values: {},
    field_states: {},
    endpoints: [],
    auth_profiles: [],
    ...overrides,
  };
}

test("Tools: a switch joins the save bar and Save sends the tools", async () => {
  let body: any = null;
  const { app } = await openConsole({
    location: "/e/default/settings/tools",
    api: {
      "GET /settings/agent": { body: agentSettings() },
      "PUT /settings/agent": (request) => {
        body = request.json;
        return { body: agentSettings() };
      },
      "GET /settings/tools/schemas": { body: { tools: { bash: { name: "bash", parameters: {} } }, channels: {} } },
    },
  });
  await app.waitFor("id:settings-tool-web_search");
  expect(app.shows("id:settings-save-bar")).toBe(false);
  await app.press("id:settings-tool-web_search-switch");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.config_revision).toBe("rev-1");
  expect(body.tools.web_search).toEqual({ enabled: true });
  expect(body.tools.bash).toEqual({ enabled: true });
  expect(body.llm).toBeUndefined();
  await app.waitFor("id:settings-save-bar", { state: "gone" });

  // The schema of a tool, in a dialog.
  await app.press("id:settings-tool-bash-schema");
  await app.waitFor("id:settings-tool-schema");
  await app.waitUntil(() => app.texts().some((text) => text.includes('"name": "bash"')));
});

test("Channels: tiles by state; a channel's pane edits its draft, and Save sends one request", async () => {
  let body: any = null;
  const { app } = await openConsole({
    location: "/e/default/settings/channels",
    api: {
      "GET /settings/console": { body: consoleSettings() },
      "PUT /settings/console": (request) => {
        body = request.json;
        return { body: consoleSettings({ managed_runtimes: [] }) };
      },
    },
  });
  await app.waitFor("id:settings-channel-telegram");
  // Telegram has a stored token: configured, and running in the console.
  await app.waitFor("text:/^configured$/i");
  expect(app.shows("id:settings-channel-telegram-running")).toBe(true);
  await app.press("id:settings-channel-telegram");
  await app.waitFor("id:settings-channel-pane");
  expect(app.value("id:settings-telegram-allowed_chat_ids_text")).toBe("42");
  await app.type("id:settings-telegram-allowed_chat_ids_text", "\n7");
  await app.press("id:settings-channel-run-in-console-switch");
  await app.waitFor("id:settings-save-bar");
  // Closing the pane keeps the draft; the tile says it is unsaved.
  await app.press("id:settings-channel-close");
  await app.waitFor("id:settings-channel-telegram-dirty");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.telegram.allowed_chat_ids).toEqual(["42", "7"]);
  expect(body.telegram.group_trigger_mode).toBe("smart");
  // A stored secret that was not edited is not sent.
  expect(body.telegram.bot_token).toBeUndefined();
  expect(body.managed_runtimes).toEqual([]);
  await app.waitFor("id:settings-save-bar", { state: "gone" });
});

test("Security: a failed save shows the error and keeps the change", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/security",
    api: {
      "GET /settings/console": { body: consoleSettings() },
      "PUT /settings/console": { status: 409, body: { error: "config changed on disk" } },
    },
  });
  await app.waitFor("id:settings-guard-approvals_enabled");
  await app.press("id:settings-guard-approvals_enabled-switch");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitFor("config changed on disk");
  await app.waitFor("id:settings-save-bar-failed");
});

test("Models: a profile opens in its pane; deleting it asks first and saves", async () => {
  let body: any = null;
  const { app } = await openConsole({
    location: "/e/default/settings/agent",
    api: {
      "GET /settings/agent": { body: agentSettings() },
      "PUT /settings/agent": (request) => {
        body = request.json;
        return { body: { config_revision: "rev-2" } };
      },
    },
  });
  await app.waitFor("id:settings-profile-cheap");
  await app.press("id:settings-profile-cheap");
  await app.waitFor("id:settings-profile-pane");
  expect(app.value("id:settings-profile-name")).toBe("cheap");
  await app.press("id:settings-profile-delete");
  await app.waitFor("id:settings-delete-profile");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => body !== null);
  expect(body.llm).toEqual({ delete_profile: "cheap" });
  await app.waitFor("id:settings-profile-cheap", { state: "gone" });
  await app.waitFor("id:settings-profile-pane", { state: "gone" });
});

test("Models: a remote agent without the settings routes shows a hint", async () => {
  const { app } = await openConsole({
    location: "/e/ep_remote/settings/agent",
    endpoints: [
      {
        endpoint_ref: "ep_remote",
        name: "Remote",
        url: "http://remote.test",
        connected: true,
        agent_name: "Remote",
        mode: "serve",
        can_submit: true,
      },
    ],
    api: { "GET /proxy:/settings/agent": { status: 404, body: { error: "not found" } } },
  });
  await app.waitFor("id:settings-unsupported");
  // A remote agent that is not a console has no console sections.
  expect(app.shows("id:settings-section-channels")).toBe(false);
});

test("search lists matching settings and opens the one chosen", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings",
    api: { ...PERSONA, "GET /settings/console": { body: consoleSettings() } },
  });
  await app.waitFor("id:settings-persona");
  await app.type("id:settings-search", "private ip");
  await app.waitFor("id:settings-search-results");
  await app.waitFor("Deny Private IPs");
  await app.press("role:option[Deny Private IPs]");
  await app.waitFor("id:settings-security");
  await app.waitFor("id:settings-guard-deny_private_ips");
  await app.clear("id:settings-search");
  await app.type("id:settings-search", "zzzz no such setting");
  await app.waitFor("No settings match.");
});

test("a save that needs a restart shows the banner, and Restart now restarts", async () => {
  let restarted = false;
  const { app } = await openConsole({
    location: "/e/default/settings/channels",
    api: {
      "GET /settings/console": { body: consoleSettings() },
      "PUT /settings/console": { body: { ...consoleSettings(), apply_mode: "process_restart" } },
      "POST /system/restart": () => {
        restarted = true;
        return { body: {} };
      },
    },
  });
  await app.waitFor("id:settings-channel-telegram");
  await app.press("id:settings-channel-telegram");
  await app.press("id:settings-channel-run-in-console-switch");
  await app.press("id:settings-save-bar-save");
  await app.waitFor("id:settings-restart-banner");
  await app.press("id:settings-restart-now");
  await app.waitUntil(() => restarted);
  // When the console answers again, the banner goes and the section loads again.
  await app.waitFor("id:settings-restart-banner", { state: "gone", timeout: 8000 });
});

test("a restart refused while tasks run offers Restart anyway", async () => {
  const forced: boolean[] = [];
  const { app } = await openConsole({
    location: "/e/default/settings/channels",
    api: {
      "GET /settings/console": { body: consoleSettings() },
      "PUT /settings/console": { body: { ...consoleSettings(), apply_mode: "runtime_restart" } },
      "POST /system/restart": (request) => {
        forced.push(request.json?.force === true);
        return request.json?.force ? { body: {} } : { status: 409, body: { error: "tasks running" } };
      },
    },
  });
  await app.waitFor("id:settings-channel-telegram");
  await app.press("id:settings-channel-telegram");
  await app.press("id:settings-channel-run-in-console-switch");
  await app.press("id:settings-save-bar-save");
  await app.press("id:settings-restart-now");
  await app.waitFor("id:settings-restart-anyway");
  await app.press("id:settings-restart-anyway");
  await app.waitUntil(() => forced.length === 2);
  expect(forced).toEqual([false, true]);
});

test("on a phone the sections come first, then a section with a back button", async () => {
  const { app } = await openConsole({ location: "/e/default/settings", width: 420, height: 800, api: PERSONA });
  await app.waitFor("id:settings-index");
  expect(app.shows("id:settings-persona")).toBe(false);
  await app.press("id:settings-section-persona");
  await app.waitFor("id:settings-persona");
  expect(app.shows("id:settings-index")).toBe(false);
  await app.press("id:settings-back");
  await app.waitFor("id:settings-index");
  expect(app.shows("id:settings-persona")).toBe(false);
});

test("System: says the config is kept in agent.db, or names the --config file", async () => {
  const dbPath = "/home/u/.morph/agent.db#config.yaml";
  const { app } = await openConsole({
    location: "/e/default/settings/system",
    api: {
      "GET /settings/system": { body: { config_path: dbPath, config_revision: "rev-1", config_values: {}, field_states: {} } },
      "GET /settings/auto-update": { body: { auto_update: { enabled: false, channel: "" }, channels: [] } },
    },
  });
  await app.waitFor("id:settings-config-store");
  await app.waitFor("text:Kept in agent.db in the state folder. Use morph config export and import to edit it as a file.");
  expect(app.texts()).toContain("agent.db");
});

test("System: names the config file given with --config", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/system",
    api: {
      "GET /settings/system": { body: { config_path: "/etc/morph/config.yaml", config_revision: "rev-1", config_values: {}, field_states: {} } },
      "GET /settings/auto-update": { body: { auto_update: { enabled: false, channel: "" }, channels: [] } },
    },
  });
  await app.waitFor("id:settings-config-store");
  await app.waitFor("text:The file named with --config: /etc/morph/config.yaml");
});
