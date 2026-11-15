// The Contacts head's kind tabs (ContactKindTabs) as shapes: two icon tabs drawn as the app's tabs
// are, quiet 16pt icons on a hairline that dips under the current one, flush, the last ending at the
// head's gutter; each a 38pt target on a desktop and a 44pt one on a phone, down to a 320pt window;
// the hairline spans both tabs (and a little more) just under a 38pt tab's foot, inside the head; a press (or an arrow
// key) chooses the other tab, a press on the current one changes nothing; the selected state and the
// dip follow. Headless runs read neither a canvas nor an icon's tint, so the dip is where the
// component places it (contactKindDipCenter) against the measured tabs, and the colours and the
// focus ring are the constants they are drawn with. The page's behaviour: tests/contacts-kinds.test.tsx.
import { expect, open, test } from "nsh/test";
import {
  CONTACT_KIND_RULE_OVERHANG,
  CONTACT_KIND_TAB_BOX,
  CONTACT_KIND_TAB_BOX_CLASS,
  CONTACT_KIND_TAB_ICON,
  CONTACT_KIND_TAB_SIZE,
  CONTACT_KIND_TAB_TOUCH,
  contactKindDipCenter,
} from "../pages/contacts/ContactKindTabs";

type Frame = { x: number; y: number; w: number; h: number };
const NAMES = ["tab-human", "tab-human-box", "tab-human-icon", "tab-agent", "tab-agent-box", "tab-agent-icon", "rule"];
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

test("the tabs are drawn as tabs: quiet icons, the current one in ink, no fill or circle, a ring for the keyboard", () => {
  const classes = CONTACT_KIND_TAB_BOX_CLASS.split(/\s+/);
  for (const cls of ["size-9", "items-center", "justify-center", "border-transparent", "group-focus-visible:border-blue"]) {
    expect(classes.includes(cls)).toBe(true);
  }
  // The round tinted toolbar button is gone: no circle, no fill in any state.
  expect(classes.includes("rounded-full")).toBe(false);
  expect(classes.some((cls) => /(^|:)bg-/.test(cls))).toBe(false);
  expect(CONTACT_KIND_TAB_ICON).toEqual({ selected: "ink", idle: "muted-foreground" });
  expect(CONTACT_KIND_TAB_SIZE).toBe(38);
  expect(CONTACT_KIND_TAB_TOUCH).toBe(44);
  expect(CONTACT_KIND_TAB_BOX).toBe(36);
});

for (const item of [
  { name: "a desktop", width: 1280, mobile: false },
  { name: "a phone", width: 390, mobile: true },
  { name: "a narrow phone", width: 320, mobile: true },
]) {
  const target = item.mobile ? CONTACT_KIND_TAB_TOUCH : CONTACT_KIND_TAB_SIZE;
  test(`on ${item.name} (${item.width}pt) each tab is a ${target}pt target with its icon in the middle, on a hairline in the head`, async () => {
    const { app, frames } = await openTabs(item.width);
    const all = frames();
    for (const kind of ["human", "agent"]) {
      const tab = all[`tab-${kind}`];
      const box = all[`tab-${kind}-box`];
      const icon = all[`tab-${kind}-icon`];
      expect(near(tab.w, target) && near(tab.h, target)).toBe(true);
      expect(near(box.w, CONTACT_KIND_TAB_BOX) && near(box.h, CONTACT_KIND_TAB_BOX)).toBe(true);
      expect(near(icon.w, 16) && near(icon.h, 16)).toBe(true);
      // The box in the middle of its target, the icon in the middle of its box.
      expect(near(centre(box).x, centre(tab).x) && near(centre(box).y, centre(tab).y)).toBe(true);
      expect(near(centre(icon).x, centre(box).x) && near(centre(icon).y, centre(box).y)).toBe(true);
      // Centred in the 57pt head.
      expect(near(centre(tab).y, HEAD / 2)).toBe(true);
    }
    // Side by side, flush, inside the window, the last ending at the head's 16pt gutter.
    const human = all["tab-human"];
    const agent = all["tab-agent"];
    expect(near(agent.x, human.x + human.w)).toBe(true);
    expect(near(agent.x + agent.w, item.width - 16)).toBe(true);
    expect(human.x).toBeGreaterThan(0);
    // The hairline: under both tabs and 8pt past them at each end (inside the gutter and the
    // window), 7pt of canvas whose line is 1pt above the foot of a 38pt tab (a phone's larger
    // targets do not move it), the dip below it still inside the head.
    const rule = all.rule;
    expect(near(rule.x, human.x - CONTACT_KIND_RULE_OVERHANG)).toBe(true);
    expect(near(rule.w, human.w + agent.w + 2 * CONTACT_KIND_RULE_OVERHANG, 1)).toBe(true);
    expect(rule.x + rule.w).toBeLessThanOrEqual(item.width);
    expect(near(rule.h, 7)).toBe(true);
    expect(near(rule.y, HEAD / 2 + CONTACT_KIND_TAB_SIZE / 2 - 1, 1)).toBe(true);
    expect(rule.y).toBeGreaterThan(all["tab-human-icon"].y + 16);
    expect(rule.y + rule.h).toBeLessThanOrEqual(HEAD);
    // The dip is under the current tab's middle, and under the other's once that is chosen.
    expect(near(rule.x + contactKindDipCenter("human", item.mobile), centre(human).x)).toBe(true);
    expect(near(rule.x + contactKindDipCenter("agent", item.mobile), centre(agent).x)).toBe(true);
    expect(app.count("label:Humans")).toBe(1);
    expect(app.count("label:Agents")).toBe(1);
    expect(app.shows("id:contacts-tab-human-selected") && app.shows("id:contacts-tab-agent-idle")).toBe(true);
    await app.press("label:Agents");
    await app.waitFor("text:kind=agent");
    expect(app.shows("id:contacts-tab-agent-selected") && app.shows("id:contacts-tab-human-idle")).toBe(true);
    // Choosing a tab moves nothing: the same frames.
    await app.wait(400);
    expect(frames()["tab-agent"]).toEqual(agent);
    expect(frames().rule).toEqual(rule);
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
