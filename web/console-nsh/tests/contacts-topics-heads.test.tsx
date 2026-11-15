// The Contacts head whole against the Topics head whole (the reference): the real column head with
// its kind tabs (IndexColumn + ContactKindTabs) over the real topic sidebar, in one window
// (tests/fixtures/contacts-topics-heads-app.tsx), on a desktop, a phone and a narrow phone, with
// either Contacts tab selected and a Topics view toggle on or off. Both heads are 57pt; a Contacts
// tab's circle is a Topics toggle's 38pt circle with its 16pt icon, at the same height in its head
// and as far from the head's bottom edge; on phones the last circle ends where the Topics head's
// last button ends; and the Contacts head's hairline lies on its bottom edge, as the Topics head's
// does, with nothing left in the head's middle. Headless runs read no fills or tints: the selected
// look is the shared classes (tests/contact-kind-tabs.test.tsx) and the selected-state test ids.
import { expect, open, test } from "nsh/test";
import { contactKindSagCenter } from "../pages/contacts/ContactKindTabs";

type Frame = { x: number; y: number; w: number; h: number };
const HEAD = 57;
const CIRCLE = 38;
const TOGGLES = ["agents", "cron", "tags", "new"];
const NAMES = [
  ...["head", "head-row", "head-title", "head-actions", "head-rule"].map((name) => `contacts:${name}`),
  ...["human", "agent"].flatMap((kind) => [`contacts:tab-${kind}`, `contacts:tab-${kind}-box`, `contacts:tab-${kind}-icon`]),
  "topics:sidebar",
  ...TOGGLES.flatMap((key) => [`topics:head-${key}`, `topics:head-${key}-icon`]),
];

async function openHeads(width: number, platform: "linux" | "android") {
  const app = await open("./fixtures/contacts-topics-heads-app.tsx", { width, height: 700, platform, locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const settle = async () => {
    await app.waitUntil(() => NAMES.every((name) => Boolean(frames()[name])));
    await app.wait(400);
    return frames();
  };
  return { app, settle };
}

const say = (what: string, value: unknown) => `${what}: ${JSON.stringify(value)}`;
function check(ok: boolean, what: string, value: unknown) {
  const at = say(what, value);
  expect({ at, ok }).toEqual({ at, ok: true });
}
const near = (a: number, b: number, by = 0.5) => Math.abs(a - b) <= by;
const centre = (f: Frame) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

/** Both heads, whole: the Contacts one against the Topics one. */
function expectHeadsMatch(all: Record<string, Frame>, width: number, mobile: boolean, kind: "human" | "agent") {
  const head = all["contacts:head"];
  const sidebar = all["topics:sidebar"];
  // The Contacts head: the window's width, the Topics head's 57pt, nothing under the head row.
  check(head.x === 0 && head.w === width && head.h === HEAD, "the Contacts head", head);
  check(all["contacts:head-row"].h === HEAD && all["contacts:head-row"].y === head.y, "the Contacts head row", all["contacts:head-row"]);
  check(sidebar.x === 0 && sidebar.w === width, "the Topics sidebar", sidebar);
  // The Topics head's buttons: 38pt circles in the middle of its 57pt head.
  const toggles = TOGGLES.map((key) => all[`topics:head-${key}`]);
  const reference = toggles[2];
  const referenceIcon = all["topics:head-tags-icon"];
  for (const toggle of toggles) {
    check(toggle.w === CIRCLE && toggle.h === CIRCLE && toggle.y === reference.y, "a Topics head button", toggle);
  }
  check(near(centre(reference).y, sidebar.y + HEAD / 2), "the Topics buttons in the middle of the head", { reference, sidebar });
  // A Contacts tab's circle and icon: a Topics toggle's, at the same place down its head, so as far
  // from the head's top and bottom edges.
  for (const tab of ["human", "agent"]) {
    const circle = all[`contacts:tab-${tab}-box`];
    const icon = all[`contacts:tab-${tab}-icon`];
    const target = all[`contacts:tab-${tab}`];
    check(circle.w === reference.w && circle.h === reference.h, `the ${tab} tab's circle the size of a Topics toggle`, { circle, reference });
    check(circle.y - head.y === reference.y - sidebar.y, `the ${tab} tab's circle as far down its head as a Topics toggle`, { circle, head, reference, sidebar });
    check(head.y + HEAD - (circle.y + circle.h) === sidebar.y + HEAD - (reference.y + reference.h), `the ${tab} tab's circle as far from the head's bottom edge`, {
      circle,
      reference,
    });
    check(icon.w === referenceIcon.w && icon.h === referenceIcon.h, `the ${tab} tab's icon the size of a Topics toggle's`, { icon, referenceIcon });
    check(icon.x - circle.x === referenceIcon.x - reference.x && icon.y - circle.y === referenceIcon.y - reference.y, `the ${tab} tab's icon placed as a Topics toggle's`, {
      icon,
      circle,
      referenceIcon,
      reference,
    });
    // The press target: the circle on a desktop, a 44pt square round it on a phone; inside the head and the window.
    const side = mobile ? 44 : CIRCLE;
    check(target.w === side && target.h === side, `the ${tab} tab's press target`, target);
    check(near(centre(target).x, centre(circle).x) && near(centre(target).y, centre(circle).y), `the ${tab} tab's target round its circle`, { target, circle });
    check(target.y >= head.y && target.y + target.h <= head.y + HEAD && target.x >= 0 && target.x + target.w <= width, `the ${tab} tab inside the head`, { target, head });
  }
  const human = all["contacts:tab-human-box"];
  const agent = all["contacts:tab-agent-box"];
  const lastToggle = toggles[toggles.length - 1];
  if (mobile) {
    // On a phone both heads end at the same gutter: the last circle where the Topics head's last
    // button is. The 44pt targets hold the circles 6pt apart (the Topics toggles are flush).
    check(agent.x === lastToggle.x, "the last tab's circle where the Topics head's last button is", { agent, lastToggle });
    check(agent.x - (human.x + human.w) === 6, "the circles 6pt apart", { human, agent });
  } else {
    // On a desktop the circles are flush, as the Topics toggles are.
    check(agent.x === human.x + human.w, "the circles flush", { human, agent });
    check(toggles.every((toggle, index) => index === 0 || toggle.x === toggles[index - 1].x + CIRCLE), "the Topics buttons flush", toggles);
  }
  check(all["contacts:head-title"].x + all["contacts:head-title"].w <= all["contacts:tab-human"].x, "the title clear of the tabs", all["contacts:head-title"]);
  // The hairline: across the head on its bottom edge (as the Topics head's: a 7pt canvas from 1pt
  // above the foot), below the circles, the dip under the selected tab's middle.
  const rule = all["contacts:head-rule"];
  check(rule.x === head.x && rule.w === head.w && rule.h === 7 && rule.y === head.y + HEAD - 1, "the hairline on the head's bottom edge", { rule, head });
  check(rule.y >= human.y + human.h, "the hairline below the circles", { rule, human });
  const dip = rule.x + all["contacts:head-actions"].x + contactKindSagCenter(kind, mobile);
  check(near(dip, centre(all[`contacts:tab-${kind}-box`]).x), `the dip under the ${kind} tab`, { dip, circle: all[`contacts:tab-${kind}-box`] });
}

for (const item of [
  { name: "a desktop", width: 1280, platform: "linux" as const, mobile: false },
  { name: "a tablet-wide desktop", width: 1024, platform: "linux" as const, mobile: false },
  { name: "a phone", width: 390, platform: "android" as const, mobile: true },
  { name: "a phone-wide web window", width: 390, platform: "linux" as const, mobile: true },
  { name: "a narrow phone", width: 320, platform: "android" as const, mobile: true },
  { name: "a narrow phone-wide web window", width: 320, platform: "linux" as const, mobile: true },
]) {
  test(`on ${item.name} (${item.width}pt) the Contacts head matches the Topics head, with either tab selected`, async () => {
    const { app, settle } = await openHeads(item.width, item.platform);
    // Humans selected, no Topics view on.
    const first = await settle();
    expect(app.shows("id:contacts-tab-human-selected") && app.shows("id:contacts-tab-agent-idle")).toBe(true);
    expectHeadsMatch(first, item.width, item.mobile, "human");
    // Agents selected, and a Topics toggle on: nothing in either head moves.
    await app.press("id:contacts-tab-agent");
    await app.waitFor("text:kind=agent");
    await app.press("id:chat-topics-view-tags");
    await app.waitFor("text:view=tags");
    expect(app.shows("id:contacts-tab-agent-selected") && app.shows("id:contacts-tab-human-idle")).toBe(true);
    const second = await settle();
    expectHeadsMatch(second, item.width, item.mobile, "agent");
    for (const name of NAMES) check(JSON.stringify(second[name]) === JSON.stringify(first[name]), `${name} stays put`, { first: first[name], second: second[name] });
    // And back to Humans.
    await app.press("id:contacts-tab-human");
    await app.waitFor("text:kind=human");
    expectHeadsMatch(await settle(), item.width, item.mobile, "human");
  });
}

test("a window resized between a desktop and a phone keeps the heads matching", async () => {
  const { app, settle } = await openHeads(1280, "linux");
  expectHeadsMatch(await settle(), 1280, false, "human");
  await app.press("id:contacts-tab-agent");
  await app.waitFor("text:kind=agent");
  await app.setViewport(320, 700);
  await app.waitUntil(() => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}")["contacts:head"]?.w === 320);
  expectHeadsMatch(await settle(), 320, true, "agent");
  await app.setViewport(1280, 700);
  await app.waitUntil(() => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}")["contacts:head"]?.w === 1280);
  expectHeadsMatch(await settle(), 1280, false, "agent");
});
