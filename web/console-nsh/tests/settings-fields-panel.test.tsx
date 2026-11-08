// ConfigSettingsPanel and SettingDialog (components/settings), mounted on their own.
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

test("a panel saves only what changed, as config changes", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:LOGGING");
  expect(app.enabled("id:panel-save")).toBe(false);
  await app.press("id:setting-logging.enabled-switch");
  await app.waitUntil(() => out(app, "dirty") === "true");
  await app.press("id:panel-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  expect(JSON.parse(out(app, "saved"))).toEqual({ config_changes: { "logging.enabled": true }, reset: [] });
});

test("a field that depends on a switch is off until the switch is on", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:LOGGING");
  expect(app.shows("text:Turn on Write logs to change this.")).toBe(true);
  expect(app.enabled("label:Level")).toBe(false);
  await app.press("id:setting-logging.enabled-switch");
  await app.waitUntil(() => !app.shows("text:Turn on Write logs to change this."));
  expect(app.enabled("label:Level")).toBe(true);
});

test("an invalid value is reported, not saved", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:LOGGING");
  await app.press("id:setting-logging.enabled-switch");
  await app.clear("label:Max size");
  await app.type("label:Max size", "ten");
  await app.press("id:panel-save");
  await app.waitFor("text:Max size must be an integer");
  expect(out(app, "saved")).toBe("null");
});

test("a clearable field resets to the default, and an environment variable locks a field", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:LOGGING");
  expect(app.value("label:Temperature")).toBe("0.7");
  await app.press("id:setting-llm.temperature-clear");
  await app.waitUntil(() => app.value("label:Temperature") === "");
  await app.press("id:panel-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  expect(JSON.parse(out(app, "saved"))).toEqual({ config_changes: {}, reset: ["llm.temperature"] });
  // MODEL comes from the environment: shown locked, by name.
  expect(app.shows("text:MODEL=gpt-5")).toBe(true);
  // A flag manages Listen, which needs a restart.
  expect(app.shows("text:Managed by a command-line flag")).toBe(true);
  expect(app.texts()).toContain("Restart required");
  // With the config in agent.db the state folder is where agent.db is: locked, and it says how to move it.
  expect(app.enabled("label:State directory")).toBe(false);
  expect(app.shows("text:/^The folder agent.db is in.*--state-dir or MISTER_MORPH_FILE_STATE_DIR/")).toBe(true);
});

test("new values from the runtime replace the draft", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:LOGGING");
  await app.press("id:setting-logging.enabled-switch");
  await app.waitUntil(() => out(app, "dirty") === "true");
  await app.press("id:reload");
  await app.waitUntil(() => out(app, "dirty") === "false");
  expect(app.shows("text:MODEL=gpt-5")).toBe(true);
});

test("an inactive group is read-only and says why", async () => {
  const { app } = await openFixture("/panel");
  await app.waitFor("text:Turned off by the desktop app.");
  expect(app.enabled("id:panel >> label:Tool timeout (seconds)")).toBe(false);
});

test("a panel with a save scope registers with the save bar, which collects its changes", async () => {
  const { app } = await openFixture("/panel");
  await app.waitUntil(() => out(app, "registered").includes("config-panel-"));
  // It shows no Save button of its own.
  expect(app.shows("id:registered-save")).toBe(false);
  await app.press("id:collect");
  await app.waitUntil(() => out(app, "collected") === "null");
  await app.clear("id:registered >> label:Tool timeout (seconds)");
  await app.type("id:registered >> label:Tool timeout (seconds)", "45");
  await app.press("id:collect");
  await app.waitUntil(() => out(app, "collected") !== "null");
  expect(JSON.parse(out(app, "collected"))).toEqual({ config_changes: { "tools.timeout": "45s" }, reset: [] });
});

test("a setting dialog cancels, saves, and cannot be closed while saving", async () => {
  const { app } = await openFixture("/dialog");
  await app.press("id:open-dialog");
  await app.waitFor("text:Edit thing");
  await app.press("text:Cancel");
  await app.waitUntil(() => out(app, "open") === "false");
  expect(out(app, "events")).toBe('["cancel"]');
  await app.press("id:open-dialog");
  await app.waitFor("text:Dialog body");
  await app.press("id:setting-dialog-save");
  await app.waitUntil(() => out(app, "events") === '["cancel","save"]');
  expect(app.enabled("text:Cancel")).toBe(false);
  expect(out(app, "open")).toBe("true");
});
