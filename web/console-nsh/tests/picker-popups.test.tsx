// The composer's two popups (components/shared/PopoverPicker.tsx, PickerList.tsx), from
// tests/fixtures/picker-popups-app.tsx: the add menu and the profile picker, as bubbles on a
// desktop and on the floating paper on a phone.
//
// Their size: a list that fits is as tall as its rows and has nothing to scroll (the scroll view's
// content is its own size, both ways: an icon's natural size, 256pt for a 16pt mark, once counted
// as overflow and gave a two-row menu 230pt of empty room to scroll); a long list is as tall as
// the window lets it be and scrolls its rows, to the last one and no further.
//
// Their highlight: the add menu's rows are actions, so none is highlighted as it opens; the
// pointer and the arrow keys give it one, Enter runs it. The profile picker opens on its chosen row.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Scroll = { w: number; h: number; cw: number; ch: number; y: number };
type Frame = { x: number; y: number; w: number; h: number };

/** The gap between two rows (`gap-0.5`). */
const ROW_GAP = 2;

interface Options {
  touch?: boolean;
  width?: number;
  height?: number;
  count?: number;
}

async function openFixture(options: Options = {}) {
  const touch = !!options.touch;
  const width = options.width ?? (touch ? 390 : 1280);
  const height = options.height ?? (touch ? 844 : 800);
  const app = await open("./fixtures/picker-popups-app.tsx", {
    width,
    height,
    locale: "en-US",
    platform: touch ? "android" : "linux",
    host: { params: { count: options.count ?? 3, touch } },
  });
  await app.waitFor("id:ready");
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, unknown>;
  /** The open popup's scroll view, asked to scroll to its top, or to its `end`. */
  const scroll = async (name: string, to: "top" | "end" = "top") => {
    await app.keyboard.press(to === "end" ? "ctrl+e" : "ctrl+m");
    await app.waitUntil(() => report()[`${name}.scroll`] !== undefined);
    return report()[`${name}.scroll`] as Scroll;
  };
  const show = async (name: string) => {
    await app.press(`id:${name}`);
    await app.waitFor(`id:${name}-list`);
    await app.wait(350);
  };
  return { app, report, scroll, show, width, height };
}

/** The values of the highlighted rows of popup `name` (one at most). */
function highlighted(app: App, name: string, values: string[]) {
  return values.filter((value) => app.count(`id:${name}-highlighted-${value}`) > 0);
}
const ACTIONS = ["upload", "attach"];

/** Nothing to scroll: the content is the scroll view's own size, across and down. */
function expectFits(scroll: Scroll) {
  expect(scroll.ch).toBe(scroll.h);
  expect(scroll.cw).toBe(scroll.w);
  expect(scroll.y).toBe(0);
}

for (const touch of [false, true]) {
  const where = touch ? "on a phone" : "on a desktop";

  test(`${where} the add menu is as tall as its two actions, with nothing to scroll and no row highlighted`, async () => {
    const { app, scroll, show, height } = await openFixture({ touch });
    await show("add");
    const first = await scroll("add");
    expectFits(first);
    // Two rows and the gap between them: no more than two rows a finger can take.
    expect(first.h).toBeGreaterThan(40);
    expect(first.h).toBeLessThanOrEqual(2 * 44 + ROW_GAP);
    expect(first.h).toBeLessThan(height / 4);
    // Asked to scroll to its end, it stays: there is no end beyond its rows.
    expectFits(await scroll("add", "end"));
    expect(highlighted(app, "add", ACTIONS)).toEqual([]);
    // Both actions are there, as commands of a menu.
    expect(app.count("role:menuitem[Upload Files]")).toBe(1);
    expect(app.count("role:menuitem[Attach Workspace]")).toBe(1);
  });

  test(`${where} a pressed action runs and closes the menu, which opens again with none highlighted`, async () => {
    const { app, report, show } = await openFixture({ touch });
    await show("add");
    await app.press("id:add-option-attach");
    await app.waitUntil(() => report().chosen === "attach");
    await app.waitFor("id:add-list", { state: "gone" });
    await show("add");
    expect(highlighted(app, "add", ACTIONS)).toEqual([]);
  });

  test(`${where} a few profiles need no scrolling and the chosen one is the highlighted row`, async () => {
    const { app, scroll, show } = await openFixture({ touch, count: 3 });
    await show("profile");
    expectFits(await scroll("profile"));
    expectFits(await scroll("profile", "end"));
    const values = ["p0", "p1", "p2"];
    expect(highlighted(app, "profile", values)).toEqual(["p0"]);
    expect(app.count("role:option[Profile 0]")).toBe(1);
    // Another choice closes it, and is the highlighted row the next time.
    await app.press("id:profile-option-p2");
    await app.waitFor("id:profile-list", { state: "gone" });
    await show("profile");
    expect(highlighted(app, "profile", values)).toEqual(["p2"]);
    expectFits(await scroll("profile"));
  });

  test(`${where} many profiles scroll: over their rows and no further, inside the window`, async () => {
    // Three rows tell how tall a row is.
    const few = await openFixture({ touch, count: 3 });
    await few.show("profile");
    const three = await few.scroll("profile");
    const row = (three.ch - 2 * ROW_GAP) / 3;
    expect(row).toBeGreaterThan(30);

    const count = 40;
    const { app, report, scroll, show, height } = await openFixture({ touch, count });
    await show("profile");
    const top = await scroll("profile");
    // The content is the rows, exactly; the view is shorter and stays inside the window.
    expect(top.ch).toBe(count * row + (count - 1) * ROW_GAP);
    expect(top.cw).toBe(top.w);
    expect(top.h).toBeLessThan(top.ch);
    expect(top.h).toBeLessThan(height);
    expect(top.h).toBeGreaterThan(3 * row);
    expect(top.y).toBe(0);
    // Its end is the last row's.
    const end = await scroll("profile", "end");
    expect(end.y).toBe(end.ch - end.h);
    expect(app.count(`id:profile-option-p${count - 1}`)).toBe(1);
    if (touch) {
      // The paper holds it all inside the window.
      const panel = report()["profile-popup.panel"] as Frame;
      expect(panel.y).toBeGreaterThanOrEqual(12);
      expect(panel.y + panel.h).toBeLessThanOrEqual(height - 12);
      expect(panel.h).toBeGreaterThan(top.h);
    }
  });

  test(`${where} in a low window many profiles still scroll to the last, and the add menu still fits`, async () => {
    const size = touch ? { width: 844, height: 390 } : { width: 1280, height: 420 };
    const { app, report, scroll, show, height } = await openFixture({ touch, count: 40, ...size });
    await show("add");
    expectFits(await scroll("add"));
    if (touch) await app.back();
    else await app.keyboard.press("escape");
    await app.waitFor("id:add-list", { state: "gone" });
    await show("profile");
    const top = await scroll("profile");
    expect(top.h).toBeLessThan(height);
    expect(top.h).toBeGreaterThan(80);
    expect(top.ch).toBeGreaterThan(top.h);
    expect(top.cw).toBe(top.w);
    const end = await scroll("profile", "end");
    expect(end.y).toBe(end.ch - end.h);
    if (touch) {
      const panel = report()["profile-popup.panel"] as Frame;
      expect(panel.y).toBeGreaterThanOrEqual(12);
      expect(panel.y + panel.h).toBeLessThanOrEqual(height - 12);
    }
    // A press on a row scrolled to still chooses it.
    await app.press("id:profile-option-p39");
    await app.waitUntil(() => report().chosen === "p39");
  });
}

test("on a desktop the pointer highlights an action while it is over it, and the arrow keys from none", async () => {
  const { app, report, show } = await openFixture();
  await show("add");
  expect(highlighted(app, "add", ACTIONS)).toEqual([]);
  await app.hover("id:add-option-attach");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["attach"]);
  await app.hover("id:add-option-upload");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["upload"]);
  // The highlight leaves with the pointer: nothing stays looking chosen.
  await app.hover("id:elsewhere");
  expect(highlighted(app, "add", ACTIONS)).toEqual([]);
  // Enter with no row highlighted runs nothing.
  await app.keyboard.press("enter");
  expect(report().chosen).toBeUndefined();
  expect(app.count("id:add-list")).toBe(1);
  // Down from none is the first row, then the next, and round; Enter runs the highlighted one.
  await app.keyboard.press("down");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["upload"]);
  await app.keyboard.press("down");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["attach"]);
  await app.keyboard.press("down");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["upload"]);
  await app.keyboard.press("enter");
  await app.waitUntil(() => report().chosen === "upload");
  await app.waitFor("id:add-list", { state: "gone" });
});

test("on a desktop Up from no highlighted action is the last one, and Escape closes the menu with nothing run", async () => {
  const { app, report, show } = await openFixture();
  await show("add");
  await app.keyboard.press("up");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["attach"]);
  await app.keyboard.press("up");
  expect(highlighted(app, "add", ACTIONS)).toEqual(["upload"]);
  await app.keyboard.press("escape");
  await app.waitFor("id:add-list", { state: "gone" });
  expect(report().chosen).toBeUndefined();
});

test("on a desktop the profile filter keeps the list as tall as its matches, and compact with none", async () => {
  const { app, report, scroll, show } = await openFixture({ count: 40 });
  await show("profile");
  const all = await scroll("profile");
  expect(all.ch).toBeGreaterThan(all.h);
  // One match.
  await app.type("id:profile-filter", "model-39");
  const one = await scroll("profile");
  expectFits(one);
  expect(one.h).toBeLessThan(all.h / 3);
  // The first match is highlighted for Enter.
  expect(app.count("id:profile-highlighted-p39")).toBe(1);
  // No match: the note alone, with nothing to scroll.
  await app.clear("id:profile-filter");
  await app.type("id:profile-filter", "zzzz");
  await app.waitFor("text:Nothing matches");
  const none = await scroll("profile");
  expectFits(none);
  expect(none.h).toBeLessThan(one.h + 1);
  expect(none.h).toBeGreaterThan(20);
  // The arrows move over the matches again, and Enter chooses.
  await app.clear("id:profile-filter");
  await app.type("id:profile-filter", "model-1");
  await app.waitFor("id:profile-option-p1");
  expect(app.count("id:profile-highlighted-p1")).toBe(1);
  await app.keyboard.press("down");
  expect(app.count("id:profile-highlighted-p10")).toBe(1);
  await app.keyboard.press("enter");
  await app.waitUntil(() => report().chosen === "p10");
  await app.waitFor("id:profile-list", { state: "gone" });
});
