// The Contacts library's remembered place (lib/scrollMemory.ts) and its two tabs (ContactKindTabs):
// the place is the tab's it was left on. The page opens on people each time, so a place left on the
// agents' tab is not put on the people's list; the people's own place comes back as before
// (tests/scroll-memory-pages.test.tsx).
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { LOCAL_REF, openConsole, scrollProbe } from "./harness";

const contact = (i: number, kind: string) => ({
  contact_id: `${kind === "agent" ? "mm" : "tg"}:${1000 + i}`,
  nickname: `${kind === "agent" ? "Agent" : "Person"} ${i + 1}`,
  kind,
  channel: kind === "agent" ? "console" : "telegram",
  status: "active",
});
const MIXED = [
  ...Array.from({ length: 80 }, (_, i) => contact(i, "human")),
  ...Array.from({ length: 80 }, (_, i) => contact(i, "agent")),
];
const EMPTY = { body: { items: [] } };
const api = {
  "GET /proxy:/topics": EMPTY,
  "GET /proxy:/tasks": EMPTY,
  "GET /proxy:/todo/tasks": EMPTY,
  "GET /proxy:/contacts/list": () => ({ body: { items: MIXED } }),
  "GET /proxy:/memories": EMPTY,
};
const LIBRARY_AREA = `contacts|${LOCAL_REF}|2|library`;

async function until(app: App, condition: () => boolean, timeout = 5000) {
  for (let waited = 0; waited < timeout && !condition(); waited += 50) await app.wait(50);
  expect(condition()).toBe(true);
}

test("the Contacts library's place belongs to its tab: the other tab, in the page or on the way back, starts at the top", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", api, scrollProbe: true });
  const probe = scrollProbe(app);
  await app.waitFor("text:Person 1");
  await app.scroll("id:contacts-index", 400);
  await until(app, () => probe.live(LIBRARY_AREA) === 400);

  // The agents' tab is another list: its top, and the people's place is not kept for it.
  probe.mark();
  await app.press("id:contacts-tab-agent");
  await app.waitFor("text:Agent 1");
  await until(app, () => probe.live(LIBRARY_AREA) === 0);
  await app.scroll("id:contacts-index", 300);
  await until(app, () => probe.live(LIBRARY_AREA) === 300);
  expect((await probe.saved())[LIBRARY_AREA]).toEqual({ y: 300, selection: "agent" });

  // Away and back: the page opens on people again, at their top, not where the agents were left.
  await app.press("id:nav-chat");
  await app.waitFor("id:contacts-index", { state: "gone" });
  // (The list reports the offsets its rows pull it back to as it goes: only what follows counts.)
  probe.mark();
  await app.press("id:nav-contacts");
  await app.waitFor("text:Person 1");
  await app.wait(600);
  expect(probe.live(LIBRARY_AREA) ?? 0).toBe(0);
  expect((await probe.saved())[LIBRARY_AREA]).toBe(undefined);
  // A scroll of a point and back makes the list report where it is: the top.
  await app.scroll("id:contacts-index", 1);
  await app.scroll("id:contacts-index", -1);
  await until(app, () => probe.live(LIBRARY_AREA) === 0);

  // The people's own place still comes back.
  await app.scroll("id:contacts-index", 400);
  await until(app, () => probe.live(LIBRARY_AREA) === 400);
  probe.mark();
  await app.press("id:nav-chat");
  await app.waitFor("id:contacts-index", { state: "gone" });
  await app.press("id:nav-contacts");
  await app.waitFor("text:Person 20");
  await until(app, () => probe.live(LIBRARY_AREA) === 400);
  expect((await probe.saved())[LIBRARY_AREA]).toEqual({ y: 400, selection: "human" });
});
