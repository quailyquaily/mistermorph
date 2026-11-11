// MenuIconTrigger (components/ui.tsx): a DropdownMenu's icon trigger that leaves the press to the
// menu, on desktops (a popup) and touch screens (a sheet); disabled, it opens nothing. Entry:
// tests/fixtures/menu-trigger-app.tsx.
import type { Platform } from "nsh/test";
import { expect, open, test } from "nsh/test";

async function openGallery(platform: Platform) {
  const app = await open("./fixtures/menu-trigger-app.tsx", { width: platform === "android" ? 390 : 1280, height: 800, locale: "en-US", platform });
  await app.waitFor("id:menu-trigger");
  return app;
}

for (const platform of ["linux", "android"] as const) {
  test(`the trigger opens its menu, and a choice runs and closes it (${platform})`, async () => {
    const app = await openGallery(platform);
    expect(app.count("role:menuitem")).toBe(0);
    await app.press("id:menu-trigger");
    await app.waitFor("role:menuitem[First action]");
    await app.waitFor("text:opened=true chosen= disabled=false");
    await app.press("role:menuitem[Second action]");
    await app.waitFor("role:menuitem", { state: "gone" });
    await app.waitFor("text:opened=false chosen=second disabled=false");
  });

  test(`disabled, the trigger opens nothing; enabled again, it does (${platform})`, async () => {
    const app = await openGallery(platform);
    await app.press("id:toggle-disabled");
    await app.waitFor("text:opened=false chosen= disabled=true");
    // Still there and named, but not a control: no press reaches a menu.
    expect(app.count("id:menu-trigger")).toBe(1);
    await expect(app.press("id:menu-trigger")).rejects.toThrow();
    expect(app.count("role:menuitem")).toBe(0);
    await app.press("id:toggle-disabled");
    await app.waitFor("text:opened=false chosen= disabled=false");
    await app.press("id:menu-trigger");
    await app.waitFor("role:menuitem[First action]");
  });
}

test("Back closes the sheet without choosing (android)", async () => {
  const app = await openGallery("android");
  await app.press("id:menu-trigger");
  await app.waitFor("role:menuitem[First action]");
  await app.back();
  await app.waitFor("role:menuitem", { state: "gone" });
  await app.waitFor("text:opened=false chosen= disabled=false");
});

test("Escape closes the popup without choosing (linux)", async () => {
  const app = await openGallery("linux");
  await app.press("id:menu-trigger");
  await app.waitFor("role:menuitem[First action]");
  await app.keyboard.press("escape");
  await app.waitFor("role:menuitem", { state: "gone" });
  await app.waitFor("text:opened=false chosen= disabled=false");
});
