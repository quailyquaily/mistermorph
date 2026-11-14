// How the Contacts page splits contacts by kind and orders a tab: by the recorded last interaction,
// newest first, never by another time; absent or unreadable times last; equal ones by contact id.
// The page itself: tests/contacts-kinds.test.tsx.
import { expect, test } from "nsh/test";
import {
  contactsOfKind,
  lastInteractionTime,
  normalizeKind,
  sortByLastInteraction,
  type Contact,
} from "../pages/contacts/contact-format";

const ids = (items: Contact[]) => items.map((item) => item.contact_id);

test("a contact is an agent only when its kind says so; anything else is a human", () => {
  expect(normalizeKind("agent")).toBe("agent");
  expect(normalizeKind(" Agent ")).toBe("agent");
  expect(normalizeKind("human")).toBe("human");
  expect(normalizeKind("")).toBe("human");
  expect(normalizeKind(undefined)).toBe("human");
  expect(normalizeKind("robot")).toBe("human");
  const items: Contact[] = [
    { contact_id: "a", kind: "agent" },
    { contact_id: "b", kind: "human" },
    { contact_id: "c" },
    { contact_id: "d", kind: "AGENT" },
    { contact_id: "e", kind: "bot" },
  ];
  expect(ids(contactsOfKind(items, "agent"))).toEqual(["a", "d"]);
  expect(ids(contactsOfKind(items, "human"))).toEqual(["b", "c", "e"]);
  expect(contactsOfKind([], "agent")).toEqual([]);
});

test("the last interaction is read from RFC 3339 times only, offsets and fractions included", () => {
  const at = (value: unknown) => lastInteractionTime({ contact_id: "x", last_interaction_at: value });
  const utc = Date.UTC(2026, 10, 14, 9, 30, 0);
  expect(at("2026-11-14T09:30:00Z")).toBe(utc);
  expect(at("2026-11-14T18:30:00+09:00")).toBe(utc);
  expect(at("2026-11-14T04:00:00-05:30")).toBe(utc);
  expect(at(" 2026-11-14t09:30:00z ")).toBe(utc);
  expect(at("2026-11-14T09:30:00.250Z")).toBe(utc + 250);
  // Go writes nanoseconds: the digits past the millisecond still order two times.
  const nanos = at("2026-11-14T09:30:00.123456789Z")!;
  expect(Math.abs(nanos - (utc + 123.456789))).toBeLessThan(0.001);
  expect(nanos).toBeGreaterThan(at("2026-11-14T09:30:00.123456Z")!);
  // None, or not a time the API writes: no interaction.
  for (const value of [
    undefined,
    null,
    "",
    "   ",
    "yesterday",
    "2026-11-14",
    "2026-11-14T09:30Z",
    "2026-11-14T09:30:00",
    "2026-02-30T09:30:00Z",
    "2026-13-01T09:30:00Z",
    "2026-11-14T24:00:00Z",
    "2026-11-14T09:60:00Z",
    "2026-11-14T09:30:00+25:00",
    "0001-01-01T00:00:00Z",
    1763112600000,
    { at: "2026-11-14T09:30:00Z" },
  ]) {
    expect(at(value)).toBe(null);
  }
  // A leap day is a day.
  expect(at("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
});

test("a tab lists the most recent interaction first, equal times by contact id, and those without one last", () => {
  const items: Contact[] = [
    { contact_id: "none-b" },
    { contact_id: "old", last_interaction_at: "2026-01-01T00:00:00Z" },
    { contact_id: "bad", last_interaction_at: "not a time" },
    { contact_id: "tie-b", last_interaction_at: "2026-11-10T12:00:00Z" },
    { contact_id: "new", last_interaction_at: "2026-11-14T08:00:00Z" },
    // The same instant written in another zone ties with tie-b.
    { contact_id: "tie-a", last_interaction_at: "2026-11-10T21:00:00+09:00" },
    { contact_id: "none-a", last_interaction_at: "" },
    { contact_id: "zero", last_interaction_at: "0001-01-01T00:00:00Z" },
  ];
  const before = ids(items);
  expect(ids(sortByLastInteraction(items))).toEqual(["new", "tie-a", "tie-b", "old", "bad", "none-a", "none-b", "zero"]);
  // A new array; the store's stays as it came.
  expect(ids(items)).toEqual(before);
  // The same however the API ordered them.
  expect(ids(sortByLastInteraction([...items].reverse()))).toEqual(ids(sortByLastInteraction(items)));
});

test("no other time stands in for a missing last interaction", () => {
  const items: Contact[] = [
    { contact_id: "c", created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:00:00Z" },
    { contact_id: "b", last_interaction_at: "2020-01-01T00:00:00Z" },
    { contact_id: "a", cooldown_until: "2026-12-01T00:00:00Z" },
  ];
  expect(ids(sortByLastInteraction(items))).toEqual(["b", "a", "c"]);
});

test("contact ids order by their characters, not the locale's collation", () => {
  const items: Contact[] = [{ contact_id: "b" }, { contact_id: "B" }, { contact_id: "a" }, { contact_id: "ä" }, { contact_id: "10" }, { contact_id: "9" }];
  expect(ids(sortByLastInteraction(items))).toEqual(["10", "9", "B", "a", "b", "ä"]);
});
