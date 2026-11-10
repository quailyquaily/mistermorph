// nsh 0.4.0's List never disposes the scope a function `empty` slot renders in: what that view reads
// keeps it alive after the list has gone. An element the list's own component made goes with it, and
// still comes and goes as the list empties and fills. Contacts' phone index depends on that
// (pages/contacts/ContactsPage.tsx, tests/contacts-todo-switch.test.tsx).
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Report = { fn: number; element: number; lists: number };

async function report(app: App): Promise<Report> {
  await app.press("id:report");
  return JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Report;
}

test("an empty slot made as an element goes with its list; a function slot's stays behind", async () => {
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
  // The runtime's trap the element works around: if this fails, nsh disposes function slots now.
  expect(counts.fn).toBeGreaterThan(0);

  // The element still shows the slot's states after its list came back.
  await app.press("id:mount");
  await app.waitFor("id:element-row-r0");
  await app.press("id:load");
  await app.waitFor("id:element-loading");
  await app.press("id:loaded");
  await app.waitFor("id:element-row-r0");
});
