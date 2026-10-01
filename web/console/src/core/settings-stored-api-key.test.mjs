import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import { modelPickerItemsFromPayload } from "./setup-picker.js";

const source = await readFile(new URL("../views/SettingsView.js", import.meta.url), "utf8");
const trimText = (value) => String(value || "").trim();

for (const provider of ["openai_chat_compatible", "anthropic", "gemini", "cloudflare"]) {
  for (const profile of [null, { _key: "row", name: "saved", _savedName: "saved" }, { _key: "row", name: "renamed", _savedName: "saved" }]) {
    test(`model lookup identifies stored credentials for ${provider}/${profile?.name || "default"}`, async () => {
      let request;
      const context = vm.createContext({
        agentLoading: { value: false },
        agentSaving: { value: false },
        agentSettingsReadOnly: { value: false },
        state: { llm: { profiles: profile ? [profile] : [] } },
        profileModelLookupCredentialsReady: () => true,
        modelPickerTargetProfileKey: {},
        modelPickerOpen: {},
        modelPickerLoading: {},
        modelPickerError: {},
        modelPickerItems: {},
        settingsEndpointRef: { value: "local" },
        llmEnvManaged: { value: {} },
        llmProfileEnvManaged: () => ({}),
        profileProviderChoice: () => provider,
        llmFieldValue: (_config, _env, field) => ({ inference_provider: provider, endpoint: "https://models.example.test/v1", api_key: "", cloudflare_api_token: "draft-token", cloudflare_account_id: "draft-account" })[field] || "",
        llmFieldEnvRawValue: () => "",
        normalizeSetupProviderChoice: (value) => value,
        setupProviderSupportsCustomAPIBase: () => true,
        SETUP_PROVIDER_MISTERMORPH_PRO: "mistermorph_pro",
        SETUP_PROVIDER_CLOUDFLARE: "cloudflare",
        trimText,
        endpointApiFetch: async (_endpoint, _path, options) => {
          request = options.body;
          return { items: ["test-model"] };
        },
        agentSettingsErrorMessage: (error) => { throw error; },
        modelPickerItemsFromPayload,
        currentLocale: () => "en",
      });
      const start = source.indexOf('    async function openModelPicker(profileKey = "")');
      const end = source.indexOf("    function applyModelOption", start);
      assert.ok(start >= 0 && end > start);
      vm.runInContext(source.slice(start, end), context);
      await context.openModelPicker(profile?._key || "");
      assert.equal(request.target_profile || "", profile?._savedName || "");
      assert.equal(request.api_key, provider === "cloudflare" ? "draft-token" : "");
      if (provider === "cloudflare") assert.equal(request.cloudflare_account_id, "draft-account");
    });
  }

}

test("benchmark keeps the saved profile identity while testing draft fields", async () => {
  let request;
  const context = vm.createContext({
    trimText,
    buildProfilePayload: (profile) => ({ name: profile.name, model: "draft-model" }),
    testConnectionLoading: { value: false },
    currentTestTargetProfile: { value: { name: "renamed", _savedName: "saved" } },
    testConnectionTargetProfileKey: { value: "row" },
    primeConnectionTestState: (_profile, payload) => payload,
    profileUsesCodexProvider: () => false,
    settingsEndpointRef: { value: "local" },
    testConnectionMeta: {},
    testConnectionBenchmarks: {},
    endpointApiFetch: async (_endpoint, _path, options) => {
      request = options.body;
      return { model: "draft-model", benchmarks: [] };
    },
    agentSettingsErrorMessage: (error) => { throw error; },
  });
  const start = source.indexOf("    function buildProfileTestPayload(profile)");
  const end = source.indexOf("    function profileProviderChoice", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const runStart = source.indexOf("    async function runConnectionTest()");
  const runEnd = source.indexOf("    function setToolEnabled", runStart);
  assert.ok(runStart >= 0 && runEnd > runStart);
  vm.runInContext(source.slice(runStart, runEnd), context);
  await context.runConnectionTest();
  assert.equal(request.target_profile, "saved");
  assert.equal(request.llm.profiles[0].name, "saved");
  assert.equal(request.llm.profiles[0].model, "draft-model");
});
