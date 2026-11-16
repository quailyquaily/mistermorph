// A List's `empty` slot goes with its list, whether it is a function or an element the list's own
// component made, and still comes and goes as the list empties and fills. Up to nsh 0.5.0 the List
// never disposed the scope a function slot rendered in (what that view read kept it alive after the
// list had gone), which is why Contacts' phone index passes an element
// (pages/contacts/ContactsPage.tsx, tests/contacts-todo-switch.test.tsx); nsh 0.5.1 disposes both.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Report = { fn: number; element: number; lists: number };

async function report(app: App): Promise<Report> {
  await app.press("id:report");
  return JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Report;
}

test("an empty slot goes with its list, made as an element or as a function", async () => {
  const app = await open("./fixtures/list-empty-slot-app.tsx", { width: 390, height: 844, platform: "android", locale: "en-US" });
  await app.waitFor("id:element-row-r0");
  for (let i = 0; i < 5; i += 1) {
    // Rows, then empty while loading (the slot shows), then the list goes away and comes back.
    await app.press("id:load");
    await app.waitFor("id:element-loading");
    await app.press("id:loaded");
    await app.waitFor("id:element-row-r0");
    await app.press("id:load");
    await app.waitFor("id:element-loading");
    await app.press("id:unmount");
    await app.waitFor("id:element-list", { state: "gone" });
    await app.press("id:mount");
    await app.waitFor("id:element-loading");
    await app.press("id:loaded");
    await app.waitFor("id:element-row-r0");
  }
  // With the lists gone, the flag changes once more.
  await app.press("id:unmount");
  await app.press("id:load");
  await app.press("id:loaded");
  const counts = await report(app);
  expect(counts.lists).toBe(12);
  expect(counts.element).toBe(0);
  // Up to nsh 0.5.0 a function slot stayed behind (the trap the element worked around).
  expect(counts.fn).toBe(0);

  // The element still shows the slot's states after its list came back.
  await app.press("id:mount");
  await app.waitFor("id:element-row-r0");
  await app.press("id:load");
  await app.waitFor("id:element-loading");
  await app.press("id:loaded");
  await app.waitFor("id:element-row-r0");
});
