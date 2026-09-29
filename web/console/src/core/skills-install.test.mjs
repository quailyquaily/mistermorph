import assert from "node:assert/strict";
import test from "node:test";

import { filterSkills, normalizeInstallLink, normalizeStoreSkill, skillInstallTask, skillSourceInfo, storeSkillLinks, storeTags, stripFrontmatter } from "./skills-install.js";

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

test("store install tasks name the store id, and updates ask to replace", () => {
  assert.equal(skillInstallTask(t, { storeID: "weather", name: "Weather" }), 'skills_install_task_store:{"name":"Weather","id":"weather"}');
  assert.equal(skillInstallTask(t, { storeID: "weather", update: true }), 'skills_install_task_store_update:{"name":"weather","id":"weather"}');
});

test("store skills normalize the index entry", () => {
  const skill = normalizeStoreSkill(
    { id: "weather", version: "1.2.0", path: "/skills/weather/", commit: "a".repeat(40), files: { "SKILL.md": "x", "notes.md": "y" }, tags: ["api", ""], installed: true, update_available: true },
    "quailyquaily/morph-skill-store",
  );
  assert.deepEqual([skill.name, skill.path, skill.fileCount, skill.tags, skill.installed, skill.updateAvailable], ["weather", "skills/weather", 2, ["api"], true, true]);
  assert.deepEqual(storeSkillLinks(skill), {
    folder: `https://github.com/quailyquaily/morph-skill-store/tree/${"a".repeat(40)}/skills/weather`,
    document: `https://raw.githubusercontent.com/quailyquaily/morph-skill-store/${"a".repeat(40)}/skills/weather/SKILL.md`,
  });
  assert.deepEqual(storeSkillLinks({ ...skill, commit: "main" }), { folder: "", document: "" });
});

test("store skills also filter by tag", () => {
  assert.deepEqual(filterSkills([{ id: "w", name: "Weather", tags: ["forecast"] }], "FORE").map((s) => s.id), ["w"]);
});

test("store tags are listed most used first", () => {
  assert.deepEqual(storeTags([{ tags: ["pdf", "Finance"] }, { tags: ["finance"] }, {}]), ["finance", "pdf"]);
});

test("SKILL.md loses its frontmatter", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\n\n# X"), "# X");
  assert.equal(stripFrontmatter("# X"), "# X");
});
