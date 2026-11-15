// The Contacts head's kind tabs (ContactKindTabs) in the column's real head (IndexColumn): two icon
// tabs drawn as the Topics head's view toggles are, the standard round 38pt button with a 16pt icon,
// the current tab a blue icon on a blue tint, the other quiet; each a 38pt target on a desktop and a
// 44pt one on a phone (the same 38pt circle in its middle), down to a 320pt window, the last circle
// ending at the head's gutter; nothing drawn in the head's middle: the head's bottom hairline dips
// under the current tab; a press (or an arrow key) chooses the other tab, a press on the current one
// changes nothing; the selected state and the dip follow. Headless runs read neither a canvas nor a
// fill or an icon's tint, so the dip is where the page places it (contactKindSagCenter) against the
// measured tabs, and the fills, colours and the focus ring are the constants they are drawn with.
// The two heads side by side: tests/contacts-topics-heads.test.tsx. The page's behaviour:
// tests/contacts-kinds.test.tsx.
import { expect, open, test } from "nsh/test";
import { CIRCLE_BUTTON_ON_FILL, circleButtonClass } from "../components/ui";
import {
  CONTACT_KIND_TAB_CIRCLE_CLASS,
  CONTACT_KIND_TAB_ICON,
  CONTACT_KIND_TAB_SIZE,
  CONTACT_KIND_TAB_TOUCH,
  contactKindSagCenter,
  contactKindStripPull,
} from "../pages/contacts/ContactKindTabs";

type Frame = { x: number; y: number; w: number; h: number };
const TABS = ["tab-human", "tab-human-box", "tab-human-icon", "tab-agent", "tab-agent-box", "tab-agent-icon"];
const NAMES = [...TABS, "head", "head-row", "head-title", "head-actions", "head-rule"];
const HEAD = 57;

async function openTabs(width: number, platform: "linux" | "android" = "linux") {
  const app = await open("./fixtures/contact-kind-tabs-app.tsx", { width, height: 600, platform, locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitUntil(() => NAMES.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

// Headless frames snap to whole points: a centre may be half a point off.
const near = (a: number, b: number, by = 0.5) => Math.abs(a - b) <= by;
const centre = (f: Frame) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
/** The head's gutter (`gutterX`, components/knowledge/parts.tsx). */
const gutter = (width: number) => (width <= 620 ? 12 : width <= 980 ? 14 : Math.min(28, Math.max(16, width * 0.02)));

test("the tabs are drawn as the Topics head's toggles: a round 38pt button, a blue tint and a blue icon on the current one, a ring for the keyboard", () => {
  const classes = CONTACT_KIND_TAB_CIRCLE_CLASS.split(/\s+/);
  // Every class of the standard round button, its hover and press fills following the tab.
  for (const cls of circleButtonClass().split(/\s+/)) {
    const mine = /^(hover|active):/.test(cls) ? `group-${cls}` : cls;
    expect([mine, classes.includes(mine)]).toEqual([mine, true]);
  }
  for (const cls of ["size-[38px]", "rounded-full", "items-center", "justify-center", "group-hover:bg-hover", "group-active:bg-press"]) {
    expect([cls, classes.includes(cls)]).toEqual([cls, true]);
  }
  // The circle is filled only while its tab is selected, with the Topics toggle's tint.
  expect(CIRCLE_BUTTON_ON_FILL).toBe("bg-blue/12");
  expect(classes.includes(`group-selected:${CIRCLE_BUTTON_ON_FILL}`)).toBe(true);
  expect(classes.some((cls) => /^bg-/.test(cls))).toBe(false);
  // The keyboard's ring, round the circle; no ring otherwise.
  expect(classes.includes("border-transparent") && classes.includes("group-focus-visible:border-blue")).toBe(true);
  // The square tab look is gone.
  expect(classes.includes("size-9") || classes.includes("rounded-md")).toBe(false);
  expect(CONTACT_KIND_TAB_ICON).toEqual({ selected: "blue", idle: "subtle" });
  expect(CONTACT_KIND_TAB_SIZE).toBe(38);
  expect(CONTACT_KIND_TAB_TOUCH).toBe(44);
});

for (const item of [
  { name: "a desktop", width: 1280, platform: "linux" as const, mobile: false },
  { name: "a tablet-wide desktop", width: 1024, platform: "linux" as const, mobile: false },
  { name: "a phone", width: 390, platform: "android" as const, mobile: true },
  { name: "a phone-wide web window", width: 390, platform: "linux" as const, mobile: true },
  { name: "a narrow phone", width: 320, platform: "android" as const, mobile: true },
]) {
  const target = item.mobile ? CONTACT_KIND_TAB_TOUCH : CONTACT_KIND_TAB_SIZE;
  test(`on ${item.name} (${item.width}pt) each tab is a ${target}pt target round a 38pt circle, in a head whose bottom hairline dips under the current one`, async () => {
    const { app, frames } = await openTabs(item.width, item.platform);
    const all = frames();
    const head = all.head;
    // The head: the column's width, 57pt, all of it the head row (nothing under it).
    expect([head.x, head.w, head.h]).toEqual([0, item.width, HEAD]);
    expect(all["head-row"]).toEqual(head);
    for (const kind of ["human", "agent"]) {
      const tab = all[`tab-${kind}`];
      const box = all[`tab-${kind}-box`];
      const icon = all[`tab-${kind}-icon`];
      expect(near(tab.w, target) && near(tab.h, target)).toBe(true);
      expect([box.w, box.h]).toEqual([CONTACT_KIND_TAB_SIZE, CONTACT_KIND_TAB_SIZE]);
      expect(near(icon.w, 16) && near(icon.h, 16)).toBe(true);
      // The circle in the middle of its target, the icon in the middle of its circle.
      expect(near(centre(box).x, centre(tab).x) && near(centre(box).y, centre(tab).y)).toBe(true);
      expect(near(centre(icon).x, centre(box).x) && near(centre(icon).y, centre(box).y)).toBe(true);
      // In the middle of the head and inside it, the target too.
      expect(near(centre(box).y, head.y + HEAD / 2)).toBe(true);
      expect(tab.y >= head.y && tab.y + tab.h <= head.y + HEAD).toBe(true);
      expect(tab.x >= 0 && tab.x + tab.w <= item.width).toBe(true);
    }
    // Side by side, the targets flush (so the circles too on a desktop, and 6pt apart on a phone),
    // the last circle ending at the head's gutter (a phone's target reaches 3pt into it), clear of
    // the title.
    const human = all["tab-human"];
    const agent = all["tab-agent"];
    const last = all["tab-agent-box"];
    expect(near(agent.x, human.x + human.w)).toBe(true);
    expect(near(last.x - (all["tab-human-box"].x + CONTACT_KIND_TAB_SIZE), target - CONTACT_KIND_TAB_SIZE)).toBe(true);
    expect(near(last.x + last.w, item.width - gutter(item.width))).toBe(true);
    expect(near(agent.x + agent.w, item.width - gutter(item.width) + contactKindStripPull(item.mobile))).toBe(true);
    expect(all["head-title"].x + all["head-title"].w).toBeLessThanOrEqual(human.x);
    // The hairline: the head's whole width, its line on the head's bottom edge (the canvas starts
    // 1pt above the foot and hangs 6pt below it for the dip), nowhere near the tabs.
    const rule = all["head-rule"];
    expect([rule.x, rule.w, rule.h]).toEqual([head.x, head.w, 7]);
    expect(rule.y).toBe(head.y + HEAD - 1);
    expect(rule.y).toBeGreaterThanOrEqual(all["tab-human-box"].y + CONTACT_KIND_TAB_SIZE);
    // The dip is under the current tab's middle, and under the other's once that is chosen.
    const strip = all["head-actions"];
    expect(near(strip.x, human.x)).toBe(true);
    expect(near(rule.x + strip.x + contactKindSagCenter("human", item.mobile), centre(all["tab-human-box"]).x)).toBe(true);
    expect(near(rule.x + strip.x + contactKindSagCenter("agent", item.mobile), centre(all["tab-agent-box"]).x)).toBe(true);
    expect(app.count("label:Humans")).toBe(1);
    expect(app.count("label:Agents")).toBe(1);
    expect(app.shows("id:contacts-tab-human-selected") && app.shows("id:contacts-tab-agent-idle")).toBe(true);
    await app.press("label:Agents");
    await app.waitFor("text:kind=agent");
    expect(app.shows("id:contacts-tab-agent-selected") && app.shows("id:contacts-tab-human-idle")).toBe(true);
    // Choosing a tab moves nothing: the same frames.
    await app.wait(400);
    expect(frames()).toEqual(all);
  });
}

test("a press chooses the other tab; the current one's press changes nothing; the selected state follows", async () => {
  const { app } = await openTabs(1280);
  expect(app.shows("id:contacts-tab-human-selected")).toBe(true);
  expect(app.shows("id:contacts-tab-agent-idle")).toBe(true);
  await app.press("id:contacts-tab-human");
  expect(app.shows("text:presses=0")).toBe(true);
  await app.press("label:Agents");
  await app.waitFor("text:kind=agent");
  expect(app.shows("text:presses=1")).toBe(true);
  expect(app.shows("id:contacts-tab-agent-selected")).toBe(true);
  expect(app.shows("id:contacts-tab-human-idle")).toBe(true);
  await app.press("id:contacts-tab-agent");
  expect(app.shows("text:presses=1")).toBe(true);
  await app.press("label:Humans");
  await app.waitFor("text:kind=human");
  expect(app.shows("text:presses=2")).toBe(true);
});

test("the keyboard: the list is one Tab stop at the current tab; the arrows, Home and End choose the other tab", async () => {
  const { app } = await openTabs(1280);
  // Tab: the button before the tabs, then the list, at the current tab.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  // Space presses the current tab, which changes nothing.
  await app.keyboard.press("space");
  expect(app.shows("text:presses=0")).toBe(true);
  expect(app.shows("text:before=0")).toBe(true);
  await app.keyboard.press("right");
  await app.waitFor("text:kind=agent");
  expect(app.shows("text:presses=1")).toBe(true);
  expect(app.shows("id:contacts-tab-agent-selected") && app.shows("id:contacts-tab-human-idle")).toBe(true);
  // Around the end, back to the first.
  await app.keyboard.press("right");
  await app.waitFor("text:kind=human");
  await app.keyboard.press("left");
  await app.waitFor("text:kind=agent");
  await app.keyboard.press("home");
  await app.waitFor("text:kind=human");
  await app.keyboard.press("end");
  await app.waitFor("text:kind=agent");
  expect(app.shows("text:presses=5")).toBe(true);
  // One stop: Tab leaves the list (round to the button) rather than going to the other tab.
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.waitFor("text:before=1");
  expect(app.shows("text:presses=5")).toBe(true);
  // And comes back in at the current tab, now Agents: Left chooses Humans.
  await app.keyboard.press("tab");
  await app.keyboard.press("left");
  await app.waitFor("text:kind=human");
  expect(app.shows("text:presses=6")).toBe(true);
});
