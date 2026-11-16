// A popup's rows are actions (a menu: Settings → Models' "···", the composer's add menu) or
// choices (a picker: a select, the LLM profiles, the setup picker). Opening a menu of actions
// highlights no row, since nothing in it is chosen: a highlighted first row read as a chosen one
// (on phones, where every DropdownMenu is the floating paper's list, the first action always was).
// A picker opens on its chosen row, and with nothing chosen on none. The keys and the pointer
// still give a highlight: the first Down takes the first enabled row, the first Up the last, and
// Enter runs the highlighted row only. Tests read no fills: the highlighted row's wrapper is named
// (`<part>-highlighted-<value>`, `setup-picker-highlighted`). Entry:
// tests/fixtures/action-popups-app.tsx; the real Models menu is in tests/settings-menus.test.tsx.
import type { App, Platform } from "nsh/test";
import { expect, open, test } from "nsh/test";

async function openFixture(platform: Platform) {
  const app = await open("./fixtures/action-popups-app.tsx", {
    width: platform === "android" ? 390 : 1280,
    height: 800,
    locale: "en-US",
    platform,
  });
  await app.waitFor("id:elsewhere");
  return app;
}

/** The highlighted rows of the list whose parts start with `part` (one at most). */
const highlighted = (app: App, part: string, values: string[]) => values.filter((value) => app.count(`id:${part}-highlighted-${value}`) > 0);
const chosen = (app: App) => app.texts().find((text) => text.startsWith("chosen="))?.slice("chosen=".length);

const COMMANDS = ["locked", "rename", "pin", "delete"];
const CHOICES = ["v0", "v1", "v2"];

test("on a phone a menu of actions opens with no row highlighted, its first one included", async () => {
  const app = await openFixture("android");
  await app.press("id:menu");
  await app.waitFor("id:menu-popup-list");
  // Commands of a menu, none of them marked as chosen.
  expect(app.count("role:menuitem")).toBe(4);
  expect(app.count("role:option")).toBe(0);
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual([]);
  // An action runs, the paper goes, and it opens again with none highlighted.
  await app.press("role:menuitem[Rename]");
  await app.waitUntil(() => chosen(app) === "rename");
  await app.waitFor("id:menu-popup-list", { state: "gone" });
  await app.press("id:menu");
  await app.waitFor("id:menu-popup-list");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual([]);
  // Back closes it with nothing run.
  await app.back();
  await app.waitFor("id:menu-popup-list", { state: "gone" });
  expect(chosen(app)).toBe("rename");
  app.dispose();
});

test("on a phone a keyboard's arrows highlight an action from none, past the disabled ones, and Enter runs only a highlighted one", async () => {
  const app = await openFixture("android");
  await app.press("id:menu");
  await app.waitFor("id:menu-popup-list");
  // Enter with no row highlighted runs nothing and leaves the menu open.
  await app.keyboard.press("enter");
  expect(chosen(app)).toBe("");
  expect(app.count("id:menu-popup-list")).toBe(1);
  // Down from none: the first row that is not disabled, then on, and round.
  await app.keyboard.press("down");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual(["rename"]);
  await app.keyboard.press("down");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual(["pin"]);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual(["rename"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => chosen(app) === "rename");
  await app.waitFor("id:menu-popup-list", { state: "gone" });
  // Up from none: the last row.
  await app.press("id:menu");
  await app.waitFor("id:menu-popup-list");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual([]);
  await app.keyboard.press("up");
  expect(highlighted(app, "menu-popup", COMMANDS)).toEqual(["delete"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => chosen(app) === "delete");
  app.dispose();
});

test("on a phone a menu with only disabled actions highlights none, whatever the keys", async () => {
  const app = await openFixture("android");
  await app.press("id:inert");
  await app.waitFor("id:inert-popup-list");
  expect(highlighted(app, "inert-popup", ["off"])).toEqual([]);
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  await app.keyboard.press("enter");
  expect(highlighted(app, "inert-popup", ["off"])).toEqual([]);
  expect(app.count("id:inert-popup-list")).toBe(1);
  expect(chosen(app)).toBe("");
  app.dispose();
});

test("on a phone a picker opens on its chosen row, and one with nothing chosen on none", async () => {
  const app = await openFixture("android");
  // A select with a value: its row is the chosen and the highlighted one.
  await app.press("label:Plain");
  await app.waitFor("id:select-popup-list");
  expect(app.count("role:option")).toBe(3);
  expect(highlighted(app, "select-popup", CHOICES)).toEqual(["v1"]);
  await app.press("role:option[Choice 2]");
  await app.waitUntil(() => chosen(app) === "select:v2");
  await app.waitFor("id:select-popup-list", { state: "gone" });
  await app.press("label:Plain");
  await app.waitFor("id:select-popup-list");
  expect(highlighted(app, "select-popup", CHOICES)).toEqual(["v2"]);
  await app.back();
  await app.waitFor("id:select-popup-list", { state: "gone" });

  // The LLM profiles' kind of picker, and a settings list.
  await app.press("id:profile");
  await app.waitFor("id:profile-list");
  expect(highlighted(app, "profile", ["p0", "p1", "p2"])).toEqual(["p1"]);
  await app.back();
  await app.waitFor("id:profile-list", { state: "gone" });
  await app.press("label:Unit");
  await app.waitFor("id:unit-popup-list");
  expect(highlighted(app, "unit-popup", ["0", "1"])).toEqual(["0"]);
  await app.back();
  await app.waitFor("id:unit-popup-list", { state: "gone" });

  // Selects with no value yet: no row looks chosen; Down still starts at the first.
  await app.press("label:Unset");
  await app.waitFor("id:unset-popup-list");
  expect(highlighted(app, "unset-popup", CHOICES)).toEqual([]);
  await app.keyboard.press("down");
  expect(highlighted(app, "unset-popup", CHOICES)).toEqual(["v0"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => chosen(app) === "unset:v0");
  await app.waitFor("id:unset-popup-list", { state: "gone" });
  await app.press("label:Chat");
  await app.waitFor("id:todo-popup-list");
  expect(highlighted(app, "todo-popup", CHOICES)).toEqual([]);
  app.dispose();
});

test("on a phone the composer's kind of add menu is a menu with no row highlighted", async () => {
  const app = await openFixture("android");
  await app.press("id:add");
  await app.waitFor("id:add-list");
  expect(app.count("role:menuitem")).toBe(2);
  expect(highlighted(app, "add", ["upload", "attach"])).toEqual([]);
  await app.press("role:menuitem[Attach]");
  await app.waitUntil(() => chosen(app) === "add:attach");
  app.dispose();
});

test("on a desktop a bubble of actions opens with none highlighted; the pointer's highlight leaves with it, the keys' stays", async () => {
  const app = await openFixture("linux");
  const rows = ["upload", "attach"];
  await app.press("id:add");
  await app.waitFor("id:add-list");
  expect(app.count("role:menuitem")).toBe(2);
  expect(highlighted(app, "add", rows)).toEqual([]);
  await app.hover("id:add-option-attach");
  expect(highlighted(app, "add", rows)).toEqual(["attach"]);
  await app.hover("id:elsewhere");
  expect(highlighted(app, "add", rows)).toEqual([]);
  await app.keyboard.press("enter");
  expect(chosen(app)).toBe("");
  await app.keyboard.press("up");
  expect(highlighted(app, "add", rows)).toEqual(["attach"]);
  await app.keyboard.press("down");
  expect(highlighted(app, "add", rows)).toEqual(["upload"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => chosen(app) === "add:upload");
  await app.waitFor("id:add-list", { state: "gone" });
  // Escape closes it with nothing more run.
  await app.press("id:add");
  await app.waitFor("id:add-list");
  expect(highlighted(app, "add", rows)).toEqual([]);
  await app.keyboard.press("escape");
  await app.waitFor("id:add-list", { state: "gone" });
  expect(chosen(app)).toBe("add:upload");
  app.dispose();
});

test("on a desktop a picker bubble opens on its chosen row, and keeps the pointer's highlight for Enter", async () => {
  const app = await openFixture("linux");
  const rows = ["p0", "p1", "p2"];
  await app.press("id:profile");
  await app.waitFor("id:profile-list");
  expect(app.count("role:option")).toBe(3);
  expect(highlighted(app, "profile", rows)).toEqual(["p1"]);
  await app.hover("id:profile-option-p2");
  await app.hover("id:elsewhere");
  expect(highlighted(app, "profile", rows)).toEqual(["p2"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => chosen(app) === "profile:p2");
  await app.waitFor("id:profile-list", { state: "gone" });
  await app.press("id:profile");
  await app.waitFor("id:profile-list");
  expect(highlighted(app, "profile", rows)).toEqual(["p2"]);
  app.dispose();
});

test("on a desktop a menu of actions opens at its trigger, runs a pressed action and closes on Escape", async () => {
  const app = await openFixture("linux");
  await app.press("id:menu");
  await app.waitFor("role:menuitem[Rename]");
  // nsh's own menu: the checked row is a checkbox item, the others plain commands; no paper.
  expect(app.count("role:menuitemcheckbox")).toBe(1);
  expect(app.count("id:menu-popup-list")).toBe(0);
  await expect(app.press("role:menuitem[Locked]")).rejects.toThrow();
  await app.press("role:menuitem[Delete]");
  await app.waitUntil(() => chosen(app) === "delete");
  await app.waitFor("role:menuitem", { state: "gone" });
  await app.press("id:menu");
  await app.waitFor("role:menuitem[Rename]");
  await app.keyboard.press("escape");
  await app.waitFor("role:menuitem", { state: "gone" });
  expect(chosen(app)).toBe("delete");
  app.dispose();
});

for (const platform of ["android", "linux"] as const) {
  test(`the setup picker with no value in use highlights no row until a key or a filter asks (${platform})`, async () => {
    const app = await openFixture(platform);
    await app.press("id:open-setup-none");
    await app.waitFor("id:setup-picker");
    await app.waitFor("role:option[Model 1]");
    expect(app.count("id:setup-picker-highlighted")).toBe(0);
    // Enter in the empty filter picks nothing.
    await app.submit("id:setup-picker-filter");
    expect(chosen(app)).toBe("");
    expect(app.count("id:setup-picker")).toBe(1);
    // Up from none is the last row, Down from none the first.
    await app.keyboard.press("up");
    expect(app.count("id:setup-picker-highlighted >> text:Model 3")).toBe(1);
    await app.keyboard.press("down");
    expect(app.count("id:setup-picker-highlighted >> text:Model 1")).toBe(1);
    // A filter highlights its first match for Enter; cleared, none again.
    await app.type("id:setup-picker-filter", "3");
    await app.waitFor("role:option[Model 1]", { state: "gone" });
    expect(app.count("id:setup-picker-highlighted >> text:Model 3")).toBe(1);
    await app.press("id:setup-picker-filter-clear");
    await app.waitFor("role:option[Model 1]");
    expect(app.count("id:setup-picker-highlighted")).toBe(0);
    await app.type("id:setup-picker-filter", "2");
    await app.waitFor("role:option[Model 1]", { state: "gone" });
    await app.submit("id:setup-picker-filter");
    await app.waitUntil(() => chosen(app) === "setup:m2");
    app.dispose();
  });

  test(`the setup picker opens on the value in use (${platform})`, async () => {
    const app = await openFixture(platform);
    await app.press("id:open-setup-chosen");
    await app.waitFor("id:setup-picker");
    await app.waitFor("id:setup-picker-highlighted");
    expect(app.count("id:setup-picker-highlighted >> text:Model 2")).toBe(1);
    expect(app.count("id:setup-picker-highlighted")).toBe(1);
    await app.submit("id:setup-picker-filter");
    await app.waitUntil(() => chosen(app) === "setup:m2");
    app.dispose();
  });
}
