// The TODO head's list/calendar toggle (TodoViewToggle) is the same round button in both views: a
// 38pt circle (as wide as it is tall) with its 16pt calendar icon in the middle, at the same place in
// the list's head and the calendar's, on a desktop and a phone. In the list it is off and named
// "Calendar"; in the calendar it is on and named "List"; each press switches the view. The
// calendar's head drew it as a plain square Button with the theme's corners before, 16pt further
// right on a desktop. Headless runs cannot read a corner radius: the round shape is the class
// CircleButton draws with.
import { expect, open, test } from "nsh/test";
import { circleButtonClass } from "../components/ui";
import { TODO_VIEW_TOGGLE_ON_CLASS } from "../components/todo/TodoViewToggle";

type Frame = { x: number; y: number; w: number; h: number };

async function openHeads(width: number) {
  const app = await open("./fixtures/todo-view-toggle-app.tsx", { width, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const settled = async () => {
    await app.waitUntil(() => Boolean(frames()["view-toggle"] && frames()["view-toggle-icon"]));
    await app.wait(100);
    return frames();
  };
  return { app, settled };
}

// Headless frames snap to whole points: a centre may be half a point off.
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

function expectRound(all: Record<string, Frame>) {
  const button = all["view-toggle"];
  const icon = all["view-toggle-icon"];
  expect(near(button.w, 38)).toBe(true);
  expect(near(button.h, 38)).toBe(true);
  expect(near(icon.w, 16) && near(icon.h, 16)).toBe(true);
  expect(near(icon.x + icon.w / 2, button.x + button.w / 2)).toBe(true);
  expect(near(icon.y + icon.h / 2, button.y + button.h / 2)).toBe(true);
  // In the middle of the 57pt head.
  expect(near(button.y + button.h / 2, 57 / 2)).toBe(true);
}

test("the toggle is drawn as the round icon button, the selected fill on in the calendar", () => {
  const classes = circleButtonClass().split(/\s+/);
  for (const cls of ["size-[38px]", "rounded-full", "items-center", "justify-center"]) expect(classes.includes(cls)).toBe(true);
  expect(TODO_VIEW_TOGGLE_ON_CLASS).toBe("selected:bg-selection");
});

for (const item of [
  { name: "a desktop", width: 1280 },
  { name: "a tablet-wide desktop", width: 1024 },
  { name: "a phone", width: 390 },
]) {
  test(`on ${item.name} the toggle is the same circle, in the same place, in the list and the calendar`, async () => {
    const { app, settled } = await openHeads(item.width);
    const list = await settled();
    expectRound(list);
    expect(app.count("label:Calendar")).toBe(1);
    expect(app.shows("label:List")).toBe(false);

    await app.press("id:todo-view-toggle");
    await app.waitFor("text:view=calendar");
    const cal = await settled();
    expectRound(cal);
    // (The calendar itself is named "Calendar" too.)
    expect(app.count("label:List")).toBe(1);
    expect(near(cal["view-toggle"].x, list["view-toggle"].x)).toBe(true);
    expect(near(cal["view-toggle"].y, list["view-toggle"].y)).toBe(true);
    // A desktop's calendar head has Add beside it, round too, as the list's.
    expect(app.shows("id:todo-calendar-add")).toBe(item.width > 980);

    await app.press("label:List");
    await app.waitFor("text:view=list");
    expectRound(await settled());
  });
}
