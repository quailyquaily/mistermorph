import assert from "node:assert/strict";
import test from "node:test";

import { filterSkills, normalizeInstallLink, skillInstallTask, skillSourceInfo } from "./skills-install.js";

const t = (key, params = {}) => `${key}:${JSON.stringify(params)}`;

test("install links must be https", () => {
  assert.equal(normalizeInstallLink(" https://github.com/o/r "), "https://github.com/o/r");
  assert.equal(normalizeInstallLink("http://github.com/o/r"), "");
  assert.equal(normalizeInstallLink("github.com/o/r"), "");
  assert.equal(normalizeInstallLink("javascript:alert(1)"), "");
});

test("install tasks name the link", () => {
  assert.equal(skillInstallTask(t, { link: "https://github.com/o/r" }), 'skills_install_task_link:{"link":"https://github.com/o/r"}');
  assert.equal(skillInstallTask(t, { link: "ftp://x" }), "");
});

test("skills without provenance are local", () => {
  assert.equal(skillSourceInfo(undefined).kind, "local");
  const info = skillSourceInfo({ kind: "store", store_id: "pdf", version: "1.0.0", commit: "abc", installed_at: "2026-09-26T00:00:00Z" });
  assert.deepEqual([info.kind, info.storeID, info.version, info.installedAt], ["store", "pdf", "1.0.0", "2026-09-26T00:00:00Z"]);
});

test("skills filter by name, id and description", () => {
  const items = [{ id: "pdf", name: "PDF tools", description: "Merge documents" }];
  assert.deepEqual(filterSkills(items, "MERGE").map((s) => s.id), ["pdf"]);
  assert.deepEqual(filterSkills(items, "nope"), []);
  assert.equal(filterSkills(items, " "), items);
});
