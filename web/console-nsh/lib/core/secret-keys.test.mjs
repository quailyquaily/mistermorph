import assert from "node:assert/strict";
import test from "node:test";

import {
  canSwapReference,
  isSecretReference,
  pickedReference,
  pickerKeys,
  referenceEnvName,
  secretFieldLabel,
} from "./secret-keys.js";

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

test("references are told apart from keys", () => {
  const cases = [
    { value: "${secret:b_LsX7HLzAR3OShG7YjRcw}", ref: true, env: "" },
    { value: " ${OPENAI_API_KEY} ", ref: true, env: "OPENAI_API_KEY" },
    { value: "${aws-sm:prod/llm#api_key}", ref: true, env: "" },
    { value: "sk-proj-abc", ref: false, env: "" },
    { value: "prefix-${OPENAI_API_KEY}", ref: false, env: "" },
    { value: "", ref: false, env: "" },
  ];
  for (const { value, ref, env } of cases) {
    assert.equal(isSecretReference(value), ref, value);
    assert.equal(referenceEnvName(value), env, value);
  }
  assert.equal(pickedReference("${OLD}", "${secret:abc}"), "${secret:abc}");
  assert.equal(pickedReference("${OLD}", ""), "${OLD}");
  assert.equal(pickedReference("${OLD}", "typed-key"), "${OLD}");
});

test("canSwapReference lets a field leave a reference only while another field keeps it", () => {
  const fields = {
    "llm.api_key": { kind: "env", env_name: "OPENAI_API_KEY", shared: true },
    "llm.profiles.chat.api_key": { kind: "env", env_name: "OPENAI_API_KEY", shared: true },
    "llm.profiles.solo.api_key": { kind: "env", env_name: "SOLO_KEY" },
    "llm.profiles.ears.api_key": { kind: "os", shared: true },
    "llm.profiles.groq.api_key": { kind: "file" },
  };
  const cases = [
    { path: "llm.api_key", envName: "OPENAI_API_KEY", want: true },
    { path: "llm.profiles.chat.api_key", envName: "", want: true },
    { path: "llm.profiles.solo.api_key", envName: "SOLO_KEY", want: false },
    { path: "llm.profiles.ears.api_key", envName: "", want: true },
    { path: "llm.profiles.groq.api_key", envName: "", want: false },
    // Set by the environment (MISTER_MORPH_LLM_API_KEY), not by what config.yaml says.
    { path: "llm.api_key", envName: "MISTER_MORPH_LLM_API_KEY", want: false },
    { path: "llm.profiles.none.api_key", envName: "", want: false },
  ];
  for (const { path, envName, want } of cases) {
    assert.equal(canSwapReference(fields, path, envName), want, `${path} ${envName}`);
  }
  assert.equal(canSwapReference(null, "llm.api_key"), false);
});
