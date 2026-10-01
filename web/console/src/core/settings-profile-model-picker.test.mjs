import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsViewSource = new URL("../views/SettingsView.js", import.meta.url);

async function readSettingsView() {
  return readFile(settingsViewSource, "utf8");
}

test("profile LLM forms expose the model picker", async () => {
  const source = await readSettingsView();
  const profileFormStart = source.indexOf('<LLMConfigForm\n                            :config="profile"');
  assert.notEqual(profileFormStart, -1, "profile LLMConfigForm not found");
  const profileFormEnd = source.indexOf("/>", profileFormStart);
  assert.notEqual(profileFormEnd, -1, "profile LLMConfigForm end not found");
  const profileForm = source.slice(profileFormStart, profileFormEnd);

  assert.match(profileForm, /:enableModelPicker="true"/);
  assert.match(profileForm, /@open-model-picker="openModelPicker\(profile\._key\)"/);
});

test("profile LLM forms use only profile-local settings", async () => {
  const source = await readSettingsView();
  const profileFormStart = source.indexOf('<LLMConfigForm\n                            :config="profile"');
  assert.notEqual(profileFormStart, -1, "profile LLMConfigForm not found");
  const profileFormEnd = source.indexOf("/>", profileFormStart);
  assert.notEqual(profileFormEnd, -1, "profile LLMConfigForm end not found");
  const profileForm = source.slice(profileFormStart, profileFormEnd);

  assert.match(profileForm, /:providerItems="providerItems"/);
  assert.match(profileForm, /:reasoningEffortItems="reasoningEffortItems"/);
  assert.match(profileForm, /:toolsEmulationItems="toolsEmulationItems"/);
  assert.doesNotMatch(profileForm, /defaultProviderItems|profileProviderItems|:defaultProvider=|allowProviderInherit|settings_agent_provider_inherit/);
  assert.doesNotMatch(source, /effectiveProfileFieldValue|hasEffectiveProfileFieldValue/);
});

test("profile model picker writes selected model to the target profile", async () => {
  const source = await readSettingsView();

  assert.match(source, /const modelPickerTargetProfileKey = ref\(""\)/);
  assert.match(source, /async function openModelPicker\(profileKey = ""\)/);
  assert.match(source, /const credentialField = providerChoice === SETUP_PROVIDER_CLOUDFLARE \? "cloudflare_api_token" : "api_key"/);
  assert.match(source, /llmFieldValue\(targetProfile, targetProfileEnvManaged, credentialField\)/);
  assert.match(source, /const targetProfile = state\.llm\.profiles\.find\(\(profile\) => profile\._key === modelPickerTargetProfileKey\.value\) \|\| null/);
  assert.match(source, /updateProfileField\(targetProfile\._key, \{ field: "model", value: nextModel \}\)/);
});

test("model picker sends environment references without exposing secret values", async () => {
  const settingsSource = await readSettingsView();
  const setupSource = await readFile(new URL("../views/SetupView.js", import.meta.url), "utf8");

  assert.match(settingsSource, /targetProfile\s*\? llmFieldEnvRawValue\(targetProfileEnvManaged, credentialField\)\s*: llmFieldEnvRawValue\(llmEnvManaged\.value, credentialField\)/);
  assert.match(settingsSource, /api_key:[\s\S]*apiKeyRaw \|\| apiKey/);
  assert.match(setupSource, /const apiKeyRaw = llmFieldEnvRawValue\(credentialFieldName\.value\)/);
  assert.match(setupSource, /api_key:[\s\S]*apiKeyRaw \|\| llmFieldValue\(credentialFieldName\.value\)/);
});

test("credential and model fields can share a desktop row", async () => {
  const formSource = await readFile(new URL("../components/LLMConfigForm.js", import.meta.url), "utf8");

  assert.match(formSource, /<div v-if="showCredentialFields" class="settings-field">/);
  assert.match(formSource, /<div :class="\['settings-field', showCredentialFields \? '' : 'is-wide'\]">/);
});

test("single LLM controls avoid the settings field control wrapper", async () => {
  const formSource = await readFile(new URL("../components/LLMConfigForm.js", import.meta.url), "utf8");

  assert.match(formSource, /const providerHasAuthAction = computed\(/);
  assert.match(formSource, /const endpointHasPickerAction = computed\(/);
  assert.match(formSource, /<div v-if="providerHasAuthAction" class="settings-field-control">/);
  assert.match(formSource, /<div v-if="providerHasAuthAction" class="settings-field-control">[\s\S]*?<EnvManagedField v-if="providerManagedField"/);
  assert.match(formSource, /<InferenceProviderPicker\s+v-else/);
  assert.match(formSource, /<div v-else-if="endpointHasPickerAction" class="settings-field-control">/);
  assert.match(formSource, /<QInput\s+v-else\s+:modelValue="config\.endpoint"/);
});

test("environment-managed fields match the 44px input height", async () => {
  const cssSource = await readFile(new URL("../components/EnvManagedField.css", import.meta.url), "utf8");

  const blockStart = cssSource.indexOf(".env-managed-field {");
  assert.notEqual(blockStart, -1, "env-managed-field block not found");
  const blockEnd = cssSource.indexOf("}", blockStart);
  const block = cssSource.slice(blockStart, blockEnd);

  assert.match(block, /height:\s*44px;/);
  assert.match(cssSource, /\.env-managed-field-name\s*\{[\s\S]*text-overflow:\s*ellipsis;/);
  assert.match(cssSource, /\.env-managed-field-name\s*\{[\s\S]*white-space:\s*nowrap;/);
});
