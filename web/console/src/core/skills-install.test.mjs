import assert from "node:assert/strict";
import test from "node:test";

import { filterSkills, normalizeInstallLink, normalizeStoreSkill, skillInstallTask, skillSourceInfo } from "./skills-install.js";

const t = (key, params = {}) => `${key}:${JSON.stringify(params)}`;

test("install links must be https", () => {
  assert.equal(normalizeInstallLink(" https://github.com/o/r "), "https://github.com/o/r");
  assert.equal(normalizeInstallLink("http://github.com/o/r"), "");
  assert.equal(normalizeInstallLink("github.com/o/r"), "");
  assert.equal(normalizeInstallLink("javascript:alert(1)"), "");
});

test("install tasks name the link or the store id", () => {
  assert.equal(skillInstallTask(t, { link: "https://github.com/o/r" }), 'skills_install_task_link:{"link":"https://github.com/o/r"}');
  assert.equal(skillInstallTask(t, { storeID: "pdf", name: "PDF" }), 'skills_install_task_store:{"name":"PDF","id":"pdf"}');
  assert.equal(skillInstallTask(t, { link: "ftp://x" }), "");
});

test("skills without provenance are local", () => {
  assert.equal(skillSourceInfo(undefined).kind, "local");
  const info = skillSourceInfo({ kind: "store", store_id: "pdf", version: "1.0.0", commit: "abc", installed_at: "2026-09-26T00:00:00Z" });
  assert.deepEqual([info.kind, info.storeID, info.version, info.installedAt], ["store", "pdf", "1.0.0", "2026-09-26T00:00:00Z"]);
});

test("store entries normalise and filter", () => {
  const item = normalizeStoreSkill({ id: "pdf", name: "PDF", tags: ["docs", ""], files: { "SKILL.md": "x", "a.md": "y" }, update_available: true });
  assert.equal(item.fileCount, 2);
  assert.deepEqual(item.tags, ["docs"]);
  assert.equal(item.updateAvailable, true);
  assert.deepEqual(filterSkills([item], "DOCS").map((s) => s.id), ["pdf"]);
  assert.deepEqual(filterSkills([item], "nope"), []);
});
