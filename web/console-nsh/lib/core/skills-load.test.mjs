import test from "node:test";
import assert from "node:assert/strict";

import { loadsAllSkills, nextSkillLoad, skillLoadEntry, skillLoadEntryMatches, skillToggleSettings } from "./skills-load.js";

const skills = [
  { id: "jsonbill", name: "jsonbill" },
  { id: "notes", name: "Notes" },
  { id: "pdf-tools", name: "PDF Tools" },
];

test("skill entries match by id or name, case-insensitively", () => {
  assert.equal(skillLoadEntry({ id: " a ", name: "b" }), "a");
  assert.equal(skillLoadEntry({ name: "b" }), "b");
  assert.equal(skillLoadEntryMatches(skills[1], "notes"), true);
  assert.equal(skillLoadEntryMatches(skills[1], "NOTES"), true);
  assert.equal(skillLoadEntryMatches(skills[2], "pdf tools"), true);
  assert.equal(skillLoadEntryMatches(skills[2], ""), false);
});

test("an empty list or * loads everything", () => {
  assert.equal(loadsAllSkills([]), true);
  assert.equal(loadsAllSkills(["*"]), true);
  assert.equal(loadsAllSkills(["notes"]), false);
});

test("switching one off from 'all' lists the others", () => {
  assert.deepEqual(nextSkillLoad([], skills, skills[1], false), ["jsonbill", "pdf-tools"]);
  assert.deepEqual(nextSkillLoad(["*"], skills, skills[0], false), ["notes", "pdf-tools"]);
});

test("switching on adds it once; covering every skill collapses to all", () => {
  assert.deepEqual(nextSkillLoad(["jsonbill"], skills, skills[1], true), ["jsonbill", "notes"]);
  assert.deepEqual(nextSkillLoad(["jsonbill", "Notes"], skills, skills[1], true), ["jsonbill", "Notes"]);
  assert.deepEqual(nextSkillLoad(["jsonbill", "notes"], skills, skills[2], true), []);
});

test("switching off removes every entry naming the skill", () => {
  assert.deepEqual(nextSkillLoad(["jsonbill", "PDF Tools", "pdf-tools"], skills, skills[2], false), ["jsonbill"]);
});

test("toggle settings never turn 'none' into 'all'", () => {
  // Switching off the last loaded skill turns skills off and keeps the list.
  assert.deepEqual(skillToggleSettings({ enabled: true, load: ["jsonbill"] }, skills, skills[0], false), { enabled: false, load: ["jsonbill"] });
  // Switching one on while skills are off loads just that one.
  assert.deepEqual(skillToggleSettings({ enabled: false, load: ["jsonbill"] }, skills, skills[1], true), { enabled: true, load: ["notes"] });
  // With a single skill, loading it collapses to "all".
  assert.deepEqual(skillToggleSettings({ enabled: false, load: [] }, [skills[0]], skills[0], true), { enabled: true, load: [] });
  // Ordinary toggles.
  assert.deepEqual(skillToggleSettings({ enabled: true, load: [] }, skills, skills[1], false), { enabled: true, load: ["jsonbill", "pdf-tools"] });
  assert.deepEqual(skillToggleSettings({ enabled: true, load: ["jsonbill"] }, skills, skills[1], true), { enabled: true, load: ["jsonbill", "notes"] });
});
