import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Settings no longer has a Skills section or sends skills", async () => {
  const source = await read("../views/SettingsView.js");
  assert.doesNotMatch(source, /selectedSection\.id === 'skills'/);
  assert.doesNotMatch(source, /state\.skills/);
  assert.doesNotMatch(source, /\bskills:\s*\{/);
  assert.doesNotMatch(source, /id:\s*"skills"/);
});

test("the Skills page switches skills with toggles, not a load-list text box", async () => {
  const source = await read("../views/SkillsView.js");
  assert.match(source, /import \{ skillToggleSettings \} from "\.\.\/core\/skills-load\.js"/);
  assert.match(source, /endpointApiFetch\(endpointRef, "\/settings\/agent\/skills"\)/);
  assert.match(source, /\/settings\/agent\/skills\/detail\?id=/);
  assert.match(source, /body: \{ config_revision: catalog\.value\.revision, skills: \{ enabled: next\.enabled, load: next\.load \} \}/);
  assert.match(source, /@update:modelValue="setLoaded\(selected, \$event\)"/);
  assert.match(source, /@update:modelValue="setEnabled"/);
  assert.doesNotMatch(source, /QTextarea/);
});

test("Skills sits after TODO in the navigation", async () => {
  const source = await read("../router/index.js");
  assert.match(source, /\{ id: "\/todo", titleKey: "nav_todo"[^}]*\},\n  \{ id: "\/skills", titleKey: "nav_skills", icon: "PhMagicWand" \}/);
  assert.match(source, /path: `\$\{ENDPOINT_SCOPE_PATH\}\/skills`, component: SkillsView/);
});

test("Add skill starts a chat task in a new topic; the page has no store", async () => {
  const source = await read("../views/SkillsView.js");
  assert.match(source, /runtimeApiFetchForEndpoint\(endpointRef, "\/tasks", \{ method: "POST", body: \{ task \} \}\)/);
  assert.match(source, /endpointRoutePath\(endpointRef, topicID \? `\/chat\/\$\{encodeURIComponent\(topicID\)\}` : "\/chat"\)/);
  assert.doesNotMatch(source, /skills\/store/);
  assert.doesNotMatch(source, /AppTabs/);
});

test("the Skills page removes a skill after a confirmation", async () => {
  const source = await read("../views/SkillsView.js");
  assert.match(source, /endpointApiFetch\(endpointState\.selectedRef, "\/settings\/agent\/skills\/remove", \{ method: "POST", body: \{ id: skill\.id \} \}\)/);
  assert.match(source, /@click="askRemove\(selected\)"/);
  assert.match(source, /action: confirmRemove/);
});
