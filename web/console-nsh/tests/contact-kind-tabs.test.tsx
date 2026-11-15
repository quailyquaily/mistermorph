// The Contacts head's kind tabs (ContactKindTabs) as shapes: two 38pt circles (the Topics head's
// round buttons) with their 16pt icons in the middle, flush, the last ending at the head's gutter;
// each a 38pt press target on a desktop and a 44pt one on a phone (the circle in its middle); a press
// chooses the other tab, a press on the current one changes nothing; the selected state follows.
// Headless runs cannot read a corner radius, so the round shape is the class the circles are drawn
// with. The page's behaviour: tests/contacts-kinds.test.tsx.
import { expect, open, test } from "nsh/test";
import { CONTACT_KIND_TAB_CIRCLE, CONTACT_KIND_TAB_CIRCLE_CLASS, CONTACT_KIND_TAB_TOUCH } from "../pages/contacts/ContactKindTabs";

type Frame = { x: number; y: number; w: number; h: number };
const NAMES = ["tab-human", "tab-human-circle", "tab-human-icon", "tab-agent", "tab-agent-circle", "tab-agent-icon"];

async function openTabs(width: number) {
  const app = await open("./fixtures/contact-kind-tabs-app.tsx", { width, height: 600, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitUntil(() => NAMES.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

// Headless frames snap to whole points: a centre may be half a point off.
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
const centre = (f: Frame) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

test("the circles are drawn round, with a ring for the keyboard and the Topics toggles' selected tint", () => {
  const classes = CONTACT_KIND_TAB_CIRCLE_CLASS.split(/\s+/);
  for (const cls of ["size-[38px]", "rounded-full", "items-center", "justify-center", "group-selected:bg-blue/12", "group-focus-visible:border-blue"]) {
    expect(classes.includes(cls)).toBe(true);
  }
  expect(CONTACT_KIND_TAB_CIRCLE).toBe(38);
  expect(CONTACT_KIND_TAB_TOUCH).toBe(44);
});

for (const item of [
  { name: "a desktop", width: 1280, target: CONTACT_KIND_TAB_CIRCLE },
  { name: "a phone", width: 390, target: CONTACT_KIND_TAB_TOUCH },
]) {
  test(`on ${item.name} each tab is a ${item.target}pt target round a 38pt circle with its icon in the middle`, async () => {
    const { app, frames } = await openTabs(item.width);
    const all = frames();
    for (const kind of ["human", "agent"]) {
      const target = all[`tab-${kind}`];
      const circle = all[`tab-${kind}-circle`];
      const icon = all[`tab-${kind}-icon`];
      expect(near(target.w, item.target) && near(target.h, item.target)).toBe(true);
      expect(near(circle.w, CONTACT_KIND_TAB_CIRCLE) && near(circle.h, CONTACT_KIND_TAB_CIRCLE)).toBe(true);
      expect(near(icon.w, 16) && near(icon.h, 16)).toBe(true);
      // The circle in the middle of its target, the icon in the middle of its circle.
      expect(near(centre(circle).x, centre(target).x) && near(centre(circle).y, centre(target).y)).toBe(true);
      expect(near(centre(icon).x, centre(circle).x) && near(centre(icon).y, centre(circle).y)).toBe(true);
      // Centred in the 57pt head.
      expect(near(centre(target).y, 57 / 2)).toBe(true);
    }
    // Side by side, flush, the last ending at the head's 16pt gutter.
    const human = all["tab-human"];
    const agent = all["tab-agent"];
    expect(near(agent.x, human.x + human.w)).toBe(true);
    expect(near(agent.x + agent.w, item.width - 16)).toBe(true);
    expect(app.count("label:Humans")).toBe(1);
    expect(app.count("label:Agents")).toBe(1);
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
  await app.press("label:Humans");
  await app.waitFor("text:kind=human");
  expect(app.shows("text:presses=2")).toBe(true);
});
