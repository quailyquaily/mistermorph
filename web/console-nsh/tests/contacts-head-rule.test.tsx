// The Contacts head's hairline follows the library's own scroll (IndexColumn `scrolled`, fed by the
// library List's offset in ContactsPage), as the Topics head's follows the topic list: none at the
// list's top, from the first opening and while the list loads; shown at any offset above 0, a
// fraction of a point too; gone again back at 0. On a desktop (the library is column 2, beside the
// open contact's panel) and on a phone (the library is the page): a tab switch (another list, at
// its top), leaving the page and coming back to a remembered place, and opening a contact and going
// back all leave it as the list now is, never as it was. The open contact's own scroll (the
// desktop panel, the phone's contact page) never shows it. Headless runs draw no canvas colours: the
// rule's test id says whether it shows (`contacts-index-rule-shown|hidden`); where it lies is in
// tests/contacts-topics-heads.test.tsx.
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
const MIXED = [...Array.from({ length: 80 }, (_, i) => contact(i, "human")), ...Array.from({ length: 80 }, (_, i) => contact(i, "agent"))];
const EMPTY = { body: { items: [] } };
// Enough memories that the open contact scrolls on its own.
const MEMORIES = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, description: `Memory ${i + 1}`, body: "Something the agent knows. ".repeat(8) }));
const api = {
  "GET /proxy:/topics": EMPTY,
  "GET /proxy:/tasks": EMPTY,
  "GET /proxy:/todo/tasks": EMPTY,
  "GET /proxy:/contacts/list": () => ({ body: { items: MIXED } }),
  "GET /proxy:/memories": { body: { items: MEMORIES } },
};
const LIBRARY_AREA = `contacts|${LOCAL_REF}|2|library`;
const CONTACT_AREA = `contacts|${LOCAL_REF}|3|contact`;
const SHOWN = "id:contacts-index-rule-shown";
const HIDDEN = "id:contacts-index-rule-hidden";

const LAYOUTS = [
  { name: "desktop (column 2)", phone: false, options: { width: 1280 } },
  { name: "phone (the page)", phone: true, options: { platform: "android" as const, width: 390 } },
];

async function until(app: App, condition: () => boolean, timeout = 5000) {
  for (let waited = 0; waited < timeout && !condition(); waited += 50) await app.wait(50);
  expect(condition()).toBe(true);
}

/** The rule shows (or not), and only one of the two ids is there. */
async function expectRule(app: App, shown: boolean) {
  await until(app, () => app.shows(shown ? SHOWN : HIDDEN));
  expect(app.count(shown ? HIDDEN : SHOWN)).toBe(0);
}

for (const layout of LAYOUTS) {
  const nav = (page: string) => (layout.phone ? `id:mobile-nav-${page}` : `id:nav-${page}`);

  test(`${layout.name}: the head's hairline shows while the library is scrolled from its top at all`, async () => {
    const { app } = await openConsole({ location: "/e/default/contacts", api, scrollProbe: true, ...layout.options });
    const probe = scrollProbe(app);
    // The first opening: at the top, none.
    await app.waitFor("id:contacts-index");
    await expectRule(app, false);
    await app.waitFor("text:Person 1");
    await app.wait(300);
    await expectRule(app, false);

    // A fraction of a point down: shown. Back to 0: gone.
    await app.scroll("id:contacts-index", 0.5);
    await expectRule(app, true);
    await app.scroll("id:contacts-index", -0.5);
    await expectRule(app, false);
    // A point, then further: shown; all the way back: gone.
    await app.scroll("id:contacts-index", 1);
    await expectRule(app, true);
    await app.scroll("id:contacts-index", 399);
    await until(app, () => probe.live(LIBRARY_AREA) === 400);
    await expectRule(app, true);
    await app.scroll("id:contacts-index", -400);
    await until(app, () => probe.live(LIBRARY_AREA) === 0);
    await expectRule(app, false);
  });

  test(`${layout.name}: tabs, leaving and coming back, and a restored place leave the hairline as the list is`, async () => {
    const { app } = await openConsole({ location: "/e/default/contacts", api, scrollProbe: true, ...layout.options });
    const probe = scrollProbe(app);
    await app.waitFor("text:Person 1");
    await app.scroll("id:contacts-index", 400);
    await until(app, () => probe.live(LIBRARY_AREA) === 400);
    await expectRule(app, true);

    // The agents' tab is another list, at its top: none.
    await app.press("id:contacts-tab-agent");
    await app.waitFor("text:Agent 1");
    await until(app, () => probe.live(LIBRARY_AREA) === 0);
    await expectRule(app, false);
    await app.scroll("id:contacts-index", 300);
    await expectRule(app, true);
    // Back to people: their list starts at its top too (the place was the agents').
    await app.press("id:contacts-tab-human");
    await app.waitFor("text:Person 1");
    await until(app, () => probe.live(LIBRARY_AREA) === 0);
    await expectRule(app, false);

    // A place to come back to: away, and back to it, shown.
    await app.scroll("id:contacts-index", 400);
    await until(app, () => probe.live(LIBRARY_AREA) === 400);
    probe.mark();
    await app.press(nav("chat"));
    await app.waitFor("id:contacts-index", { state: "gone" });
    await app.press(nav("contacts"));
    await app.waitFor("id:contacts-index");
    await until(app, () => probe.live(LIBRARY_AREA) === 400);
    await expectRule(app, true);

    // Back at the top, away and back: nothing is remembered, and none shows.
    await app.scroll("id:contacts-index", -400);
    await until(app, () => probe.live(LIBRARY_AREA) === 0);
    await expectRule(app, false);
    probe.mark();
    await app.press(nav("chat"));
    await app.waitFor("id:contacts-index", { state: "gone" });
    await app.press(nav("contacts"));
    await app.waitFor("text:Person 1");
    await app.wait(600);
    expect(probe.live(LIBRARY_AREA) ?? 0).toBe(0);
    await expectRule(app, false);
  });

  test(`${layout.name}: the open contact's own scroll leaves the library's hairline alone`, async () => {
    const { app } = await openConsole({ location: "/e/default/contacts", api, scrollProbe: true, ...layout.options });
    const probe = scrollProbe(app);
    await app.waitFor("text:Person 1");
    await expectRule(app, false);

    // At the library's top, a contact scrolled: still none.
    await app.press("id:contact-row:tg:1000");
    await app.waitFor("text:Memory 1");
    await app.scroll("text:Memory 1", 300);
    await until(app, () => (probe.live(CONTACT_AREA) ?? 0) > 0);
    if (layout.phone) {
      // The library is behind the contact's page: back to it, at its top.
      await app.press("id:mobile-back");
      await app.waitFor("id:contacts-index");
      await app.wait(400);
    }
    await expectRule(app, false);

    // The library scrolled, then a contact opened from it and closed (desktop: the panel beside it;
    // phone: its page over the library, then back): still shown, the list where it was.
    await app.scroll("id:contacts-index", 400);
    await until(app, () => probe.live(LIBRARY_AREA) === 400);
    await expectRule(app, true);
    probe.mark();
    await app.press("text:Person 20");
    await app.waitFor("text:Memory 1");
    // (Another contact: its page starts at its top.)
    await until(app, () => (probe.live(CONTACT_AREA) ?? 0) === 0);
    await app.scroll("text:Memory 1", 300);
    await until(app, () => (probe.live(CONTACT_AREA) ?? 0) > 0);
    if (!layout.phone) await expectRule(app, true);
    if (layout.phone) {
      await app.press("id:mobile-back");
      await app.waitFor("id:contacts-index");
      await until(app, () => probe.live(LIBRARY_AREA) === 400);
    } else {
      await app.press("id:contact-close");
    }
    await expectRule(app, true);
  });
}
