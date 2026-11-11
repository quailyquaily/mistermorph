// The contacts list going from rows to none through a reload: deleting the last contact reloads
// the list, which shows its loading blocks and then, with nothing in it, says so. The list's
// `empty` view is an element its component made (the FT70 lifecycle fix, pages/contacts/
// ContactsPage.tsx `IndexList`); an `If` in that element stopped switching once the list had hidden
// it and shown it again, so the loading blocks stayed and the note never came. On a phone and a
// desktop, with the reload answering at once and late.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

const ALICE = {
  contact_id: "tg:1001",
  nickname: "Alice",
  kind: "human",
  channel: "telegram",
  tg_username: "alice",
  status: "active",
  avatar_url: "",
};

function api(state: { deleted: boolean; loads: number }, delay: number): Record<string, ApiHandler> {
  return {
    "GET /proxy:/contacts/list": () => {
      state.loads += 1;
      return { body: { items: state.deleted ? [] : [ALICE] }, delay: state.deleted ? delay : 0 };
    },
    "GET /proxy:/memories": { body: { items: [] } },
    "DELETE /proxy:/contacts/item": () => {
      state.deleted = true;
      return { body: {} };
    },
  };
}

for (const layout of ["phone", "desktop"] as const) {
  // Late: well past the time a step of the test takes, so the reload is still out when it looks.
  for (const delay of [0, 1500]) {
    const timing = delay ? "a late reload" : "a reload at once";
    test(`${layout}: deleting the last contact, with ${timing}, says there are none`, async () => {
      const state = { deleted: false, loads: 0 };
      const { app } = await openConsole({
        location: "/e/default/contacts",
        ...(layout === "phone" ? { platform: "android" as const } : {}),
        api: api(state, delay),
      });
      await app.waitFor("id:contact-row:tg:1001");
      expect(app.shows("id:contacts-empty")).toBe(false);
      await app.press("id:contact-row:tg:1001");
      await app.waitFor("id:contact-detail");
      await app.press("id:contact-actions");
      await app.press("role:menuitem[Delete]");
      const loadsBefore = state.loads;
      await app.press("id:dialog-action-delete");
      // The reload after the delete is out.
      await app.waitUntil(() => state.deleted && state.loads > loadsBefore);
      if (delay) {
        // While the reload is out: the loading blocks, not the note.
        expect(app.shows("id:contacts-empty")).toBe(false);
      }
      await app.waitFor("text:No contacts");
      await app.waitFor("id:contact-row:tg:1001", { state: "gone" });
      expect(app.shows("id:contacts-list")).toBe(true);
      if (layout === "desktop") expect(app.shows("text:No contact selected")).toBe(true);
    });
  }
}
