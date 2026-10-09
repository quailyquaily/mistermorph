import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsViewSource = new URL("../views/SettingsView.js", import.meta.url);

test("Settings action notices use the floating notice stack instead of inline notices", async () => {
  const source = await readFile(settingsViewSource, "utf8");

  assert.match(source, /if \(notify\) notice\.success\(t\("msg_save_success"\)\);/);
  assert.match(source, /if \(notify\) notice\.success\(settingsSavedMessage\(payload\)\);/);
  // The section save bar reports one combined result.
  assert.match(source, /notice\.success\(settingsSavedMessage\(\{ apply_mode: takeSavedApplyMode\(\) \}\)\);/);
  assert.match(source, /notice\.success\(t\("settings_desktop_update_checksum_copied"\)\);/);

  assert.doesNotMatch(source, /:text="agentOk"/);
  assert.doesNotMatch(source, /:text="agentErr"/);
  assert.doesNotMatch(source, /:text="consoleOk"/);
  assert.doesNotMatch(source, /:text="consoleErr"/);
  assert.doesNotMatch(source, /:text="desktopOk"/);
  assert.doesNotMatch(source, /:text="desktopErr"/);

  assert.match(source, /:text="agentValidationError"/);
});
