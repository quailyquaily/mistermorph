// The Topics head's icons (the agents, TODO runs and tag toggles, and New) are drawn at a regular
// icon-only Button's icon size (BAR_BUTTON_SIZE's 16pt, the TODO head's calendar toggle and the
// phone bars' back arrows), measured against such a Button beside the sidebar: on a desktop and on
// phones, with New in the head or floating (split mode), with the TODO runs' alarm clock turning,
// and with no topics yet. The buttons keep their 38pt squares flush in a row, each icon centred in
// its square and inside the head; their names, tooltips and presses stay. Status marks and group
// carets keep their own small sizes (tests/topic-status-alignment.test.tsx, the 7pt marks).
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };
type Mode = "plus" | "split" | "empty";

async function openHead(width: number, platform: "linux" | "android", mode: Mode) {
  const app = await open("./fixtures/topic-head-icons-app.tsx", { width, height: 700, platform, locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const presses = () => app.texts().find((text) => text.startsWith("presses:")) ?? "";
  if (mode !== "plus") await app.press(`id:mode-${mode}`);
  const keys = headKeys(mode);
  const needed = ["sidebar", "reference", "reference-icon", ...keys.flatMap((key) => [`head-${key}`, `head-${key}-icon`])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames, presses };
}

// The head's buttons in order: the agents toggle shows while there are agent topics, New while it
// is not floating over the list.
const headKeys = (mode: Mode) => [...(mode === "empty" ? [] : ["agents"]), "cron", "tags", ...(mode === "plus" ? ["new"] : [])];

const centerX = (frame: Frame) => frame.x + frame.w / 2;
const centerY = (frame: Frame) => frame.y + frame.h / 2;
const near = (a: number, b: number, within = 0.5) => Math.abs(a - b) <= within;

const CASES = [
  { name: "a desktop", width: 1280, platform: "linux" as const, mode: "plus" as const },
  { name: "a phone with New in the head", width: 390, platform: "android" as const, mode: "plus" as const },
  { name: "a phone in split mode", width: 390, platform: "android" as const, mode: "split" as const },
  { name: "a phone-wide web window with no topics yet", width: 390, platform: "linux" as const, mode: "empty" as const },
  { name: "a tablet-wide desktop", width: 1024, platform: "linux" as const, mode: "plus" as const },
  { name: "the narrowest phone-wide web window", width: 320, platform: "linux" as const, mode: "plus" as const },
];

for (const item of CASES) {
  test(`on ${item.name} the head's icons are a regular icon button's size`, async () => {
    const { frames } = await openHead(item.width, item.platform, item.mode);
    const all = frames();
    const reference = all.reference;
    const standard = all["reference-icon"];
    // The reference: a 38pt icon-only Button with its 16pt icon.
    expect(near(reference.w, 38) && near(reference.h, 38)).toBe(true);
    expect(near(standard.w, 16) && near(standard.h, 16)).toBe(true);
    const sidebar = all.sidebar;
    let previous: Frame | undefined;
    for (const key of headKeys(item.mode)) {
      const button = all[`head-${key}`];
      const icon = all[`head-${key}-icon`];
      // The icon at the reference's size (the alarm clock too, turning or not)...
      expect([key, icon.w, icon.h]).toEqual([key, standard.w, standard.h]);
      // ...centred in an unchanged 38pt hit area, as far in as the reference's icon...
      expect(near(button.w, 38) && near(button.h, 38)).toBe(true);
      expect(near(centerX(icon), centerX(button)) && near(centerY(icon), centerY(button))).toBe(true);
      expect(near(icon.x - button.x, standard.x)).toBe(true);
      // ...and the buttons flush in a row, inside the head.
      if (previous) {
        expect(near(button.x, previous.x + previous.w)).toBe(true);
        expect(near(button.y, previous.y)).toBe(true);
      }
      expect(button.x).toBeGreaterThan(sidebar.x);
      expect(button.x + button.w).toBeLessThanOrEqual(sidebar.x + sidebar.w);
      previous = button;
    }
    // The last button's icon is still the one the rows' status marks are centred under.
    const last = headKeys(item.mode).at(-1)!;
    expect(all["head-icon"]).toEqual(all[`head-${last}-icon`]);
  });
}

test("the head's buttons keep their names, tooltips and presses", async () => {
  const { app, presses } = await openHead(1280, "linux", "plus");
  expect(app.count("label:Conversations other agents started")).toBe(1);
  expect(app.count("label:TODO runs — 1 running")).toBe(1);
  expect(app.count("label:Arrange by tag")).toBe(1);
  expect(app.count("label:New Topic")).toBe(1);
  // The TODO toggle's clock is turning (a run is on).
  expect(app.count("id:chat-cron-running")).toBe(1);
  await app.hover("id:chat-topics-view-tags");
  await app.waitFor("text:Arrange by tag");
  await app.press("id:chat-topics-view-agents");
  await app.press("id:chat-topics-view-cron");
  await app.press("id:chat-topics-view-tags");
  await app.press("id:chat-topic-new");
  await app.waitUntil(() => presses() === "presses:view:agents,view:cron,view:tags,new");
});
