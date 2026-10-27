import assert from "node:assert/strict";
import test from "node:test";

import {
  hearAsOptions,
  isClaim,
  journalDays,
  matchesQuery,
  memorySections,
  subjectID,
  subjectKind,
  subjectsOf,
} from "./memories-view.js";

const items = [
  { id: "m1", subject: "contact:alice", type: "person", learned_in: "contact:alice", told_by: "alice", name: "role" },
  { id: "m2", subject: "owner", type: "context", learned_in: "owner", name: "q4-goal" },
  { id: "m3", subject: "owner", type: "feedback", learned_in: "owner", name: "release-notes" },
  { id: "m4", subject: "contact:bob", type: "person", learned_in: "contact:alice", told_by: "alice", name: "role" },
  { id: "m5", subject: "conversation:tg:-100", type: "feedback", learned_in: "conversation:tg:-100", name: "english" },
  { id: "m6", subject: "general", type: "reference", learned_in: "owner", name: "status" },
];

test("subject kinds and IDs", () => {
  for (const [value, kind, id] of [
    ["owner", "owner", ""],
    ["general", "general", ""],
    ["contact:tg:@alice", "contact", "tg:@alice"],
    ["conversation:tg:-100", "conversation", "tg:-100"],
    ["", "", ""],
    ["weird", "", ""],
  ]) {
    assert.equal(subjectKind(value), kind, value);
    assert.equal(subjectID(value), id, value);
  }
});

test("subjectsOf orders the owner, general, contacts, then conversations", () => {
  assert.deepEqual(
    subjectsOf(items).map((s) => `${s.subject}:${s.count}`),
    ["owner:2", "general:1", "contact:alice:1", "contact:bob:1", "conversation:tg:-100:1"],
  );
});

test("subjectsOf can list subjects that have no memories yet", () => {
  assert.deepEqual(
    subjectsOf([items[0]], ["owner", "general"]).map((s) => `${s.subject}:${s.count}`),
    ["owner:0", "general:0", "contact:alice:1"],
  );
  assert.deepEqual(subjectsOf([], ["owner"]).map((s) => s.subject), ["owner"]);
});

test("hearAsOptions lists the owner, then every DM and conversation involved", () => {
  assert.deepEqual(hearAsOptions(items), ["owner", "contact:alice", "contact:bob", "conversation:tg:-100"]);
  assert.deepEqual(hearAsOptions([]), ["owner"]);
});

test("a contact's word about someone else is a claim", () => {
  assert.equal(isClaim(items[0]), false, "Alice about herself");
  assert.equal(isClaim(items[3]), true, "Alice about Bob");
  assert.equal(isClaim(items[1]), false, "the owner");
});

test("memorySections: per subject with rules first, or rules then facts", () => {
  assert.deepEqual(
    memorySections(items, "").map((s) => `${s.subject}=${s.items.map((i) => i.id).join(",")}`),
    ["owner=m3,m2", "general=m6", "contact:alice=m1", "contact:bob=m4", "conversation:tg:-100=m5"],
  );
  assert.deepEqual(
    memorySections(items, "owner").map((s) => `${s.key}=${s.items.map((i) => i.id).join(",")}`),
    ["rules=m3", "facts=m2"],
  );
  assert.deepEqual(memorySections(items, "contact:nobody"), []);
});

test("matchesQuery looks in the words and the labels", () => {
  assert.equal(matchesQuery({ description: "Release freeze", body: "" }, "freeze"), true);
  assert.equal(matchesQuery({ description: "x" }, "alice", ["Alice Chen"]), true);
  assert.equal(matchesQuery({ description: "x" }, "bob"), false);
  assert.equal(matchesQuery({ description: "x" }, "  "), true);
});

test("journalDays groups consecutive events by day", () => {
  const days = journalDays(
    [{ time: "2026-10-26T09:00:00Z" }, { time: "2026-10-26T08:00:00Z" }, { time: "2026-10-23T17:00:00Z" }],
    (time) => time.slice(0, 10),
  );
  assert.deepEqual(days.map((d) => `${d.label}:${d.events.length}`), ["2026-10-26:2", "2026-10-23:1"]);
});
