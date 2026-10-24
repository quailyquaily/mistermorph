import assert from "node:assert/strict";
import test from "node:test";

import { pickerKeys, secretFieldLabel } from "./secret-keys.js";

const MESSAGES = {
  secret_picker_main_model: "Main model",
  secret_picker_profile: "Profile {name}",
  settings_agent_bedrock_aws_secret_label: "AWS Secret",
  settings_console_telegram_bot_token_label: "Bot Token",
};

function t(key, vars) {
  let text = MESSAGES[key] ?? key;
  for (const [name, value] of Object.entries(vars || {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

test("secretFieldLabel names each secret field in words", () => {
  const cases = [
    { path: "llm.api_key", want: "Main model" },
    { path: "llm.profiles.ears.api_key", want: "Profile ears" },
    { path: "llm.profiles.ears.bedrock.aws_secret", want: "Profile ears · AWS Secret" },
    { path: "llm.cloudflare.api_token", want: "Main model · cloudflare_api_token" },
    { path: "telegram.bot_token", want: "Telegram Bot Token" },
    { path: "slack.app_token", want: "Slack app_token" },
    { path: "other.secret", want: "other.secret" },
  ];
  for (const { path, want } of cases) {
    assert.equal(secretFieldLabel(path, t), want, path);
  }
});

test("pickerKeys leaves out the field's own key and offers the same kind of field first", () => {
  const keys = [
    { id: "bot", used_by: ["telegram.bot_token"] },
    { id: "chat", used_by: ["llm.profiles.chat.api_key"] },
    { id: "own", used_by: ["llm.api_key", "llm.profiles.ears.api_key"] },
    { id: "backup", used_by: ["llm.profiles.backup.api_key"] },
  ];
  assert.deepEqual(pickerKeys(keys, "llm.profiles.ears.api_key").map((key) => key.id), ["chat", "backup", "bot"]);
  assert.deepEqual(pickerKeys(keys, "telegram.bot_token").map((key) => key.id), ["chat", "own", "backup"]);
  // A new profile has no path yet: every key is offered, newest first.
  assert.deepEqual(pickerKeys(keys, "").map((key) => key.id), ["bot", "chat", "own", "backup"]);
  assert.deepEqual(pickerKeys(null, "llm.api_key"), []);
});
