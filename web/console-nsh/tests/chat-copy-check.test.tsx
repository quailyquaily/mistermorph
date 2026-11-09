// The check a message's copy button shows once copied is drawn as a pen draws it: the short
// stroke down, then the long one up, at the copy icon's size (components/chat/copyCheck.ts).
import { expect, test } from "nsh/test";
import { CHECK_CORNER_AT, CHECK_SIZE, checkAction, checkDash, checkDashOffset, checkStroke, checkStrokeAt } from "../components/chat/copyCheck";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const DONE = {
  id: "t1",
  task: "Clean the disk",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  status: "done",
  result: { final: { output: "All done." } },
};
const API = {
  "GET /proxy:/topics": TOPICS,
  "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [DONE] : [] } }),
};
const AGENT_COPY = "id:chat-item-agent >> label:Copy";
const AGENT_CHECK = "id:chat-item-agent >> id:chat-copy-check";
const USER_COPY = "id:chat-item-user >> label:Copy";
const USER_CHECK = "id:chat-item-user >> id:chat-copy-check";

const close = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);

test("the check is the copy icon's size and weight: a short stroke down, then a long one up", () => {
  const stroke = checkStroke();
  expect(CHECK_SIZE).toBe(14);
  const [start, corner, end] = stroke.points;
  // Phosphor's check (40,144 96,200 224,72 on 256, 16 wide) in the 14pt box.
  expect(close(start, [(40 * 14) / 256, (144 * 14) / 256])).toBe(true);
  expect(close(corner, [(96 * 14) / 256, (200 * 14) / 256])).toBe(true);
  expect(close(end, [(224 * 14) / 256, (72 * 14) / 256])).toBe(true);
  expect(stroke.width).toBe(0.875);
  // Down and to the right first, then up and to the right, longer.
  expect(corner[0]).toBeGreaterThan(start[0]);
  expect(corner[1]).toBeGreaterThan(start[1]);
  expect(end[0]).toBeGreaterThan(corner[0]);
  expect(end[1]).toBeLessThan(corner[1]);
  expect(stroke.up).toBeGreaterThan(stroke.down * 2);
  expect(Math.abs(stroke.corner - stroke.down / stroke.length)).toBeLessThan(1e-9);
  // Inside the box with its round caps.
  for (const [x, y] of stroke.points) {
    expect(Math.min(x, y)).toBeGreaterThan(stroke.width / 2);
    expect(Math.max(x, y)).toBeLessThan(CHECK_SIZE - stroke.width / 2);
  }
  // The timing reaches the corner before the long stroke starts.
  expect(CHECK_CORNER_AT).toBeGreaterThan(0);
  expect(CHECK_CORNER_AT).toBeLessThan(1);
});

test("the stroke is revealed in path order, from nothing to the whole check", () => {
  const stroke = checkStroke();
  const [start, corner, end] = stroke.points;
  expect(checkStrokeAt(stroke, 0)).toEqual([start]);
  expect(checkStrokeAt(stroke, -1)).toEqual([start]);
  // Halfway down the short stroke: no corner yet.
  const early = checkStrokeAt(stroke, stroke.corner / 2);
  expect(early).toHaveLength(2);
  expect(close(early[1], [(start[0] + corner[0]) / 2, (start[1] + corner[1]) / 2])).toBe(true);
  // At the corner: the short stroke whole, the long one not started.
  const turned = checkStrokeAt(stroke, stroke.corner);
  expect(turned).toHaveLength(2);
  expect(close(turned[1], corner)).toBe(true);
  // On the long stroke the pen rises.
  const rising = checkStrokeAt(stroke, (stroke.corner + 1) / 2);
  expect(rising).toHaveLength(3);
  expect(close(rising[1], corner)).toBe(true);
  expect(rising[2][1]).toBeLessThan(corner[1]);
  expect(rising[2][1]).toBeGreaterThan(end[1]);
  const whole = checkStrokeAt(stroke, 1);
  expect(close(whole[2], end)).toBe(true);
  expect(checkStrokeAt(stroke, 2)).toEqual(whole);

  // The dash hides the whole path (round cap included) at 0 and none of it at 1.
  const dash = checkDash(stroke);
  expect(dash.segments[0]).toBe(stroke.length);
  expect(dash.segments[1]).toBeGreaterThan(dash.hidden);
  expect(dash.hidden).toBeGreaterThan(stroke.length);
  expect(checkDashOffset(stroke, 0)).toBe(dash.hidden);
  expect(checkDashOffset(stroke, 1)).toBe(0);
  expect(Math.abs(checkDashOffset(stroke, 0.5) - dash.hidden / 2)).toBeLessThan(1e-9);
});

test("each successful copy draws the check again; reduced motion and a row bound again show it whole", () => {
  // A new copy of this message, also one repeated while the check shows.
  expect(checkAction(0, 1, true, false)).toBe("draw");
  expect(checkAction(1, 2, true, false)).toBe("draw");
  // Reduced motion: the whole check at once.
  expect(checkAction(0, 1, true, true)).toBe("show");
  // Copied, but no new copy (the row mounted or was bound again while the check holds).
  expect(checkAction(3, 3, true, false)).toBe("show");
  // Not copied: idle, another message copied, or the check expired.
  expect(checkAction(0, 0, false, false)).toBe("none");
  expect(checkAction(1, 2, false, false)).toBe("none");
  expect(checkAction(1, 1, false, true)).toBe("none");
});

test("copy copies the message and shows the check until 1.2 s after the last copy", async () => {
  const { app } = await openConsole({ location: CHAT, api: API, clock: true });
  await app.waitFor("text:All done.");
  expect(app.count("id:chat-copy-check")).toBe(0);

  await app.press(AGENT_COPY);
  expect(app.clipboard()).toBe("All done.");
  expect(app.count(AGENT_CHECK)).toBe(1);
  expect(app.count("id:chat-copy-check")).toBe(1);

  // Copying again while the check shows keeps it, and starts the 1.2 s over.
  await app.clock!.runFor(800);
  await app.press(AGENT_COPY);
  expect(app.clipboard()).toBe("All done.");
  await app.clock!.runFor(800);
  expect(app.count(AGENT_CHECK)).toBe(1);
  await app.clock!.runFor(500);
  expect(app.count("id:chat-copy-check")).toBe(0);

  // Copying another message moves the check to it.
  await app.press(AGENT_COPY);
  await app.press(USER_COPY);
  expect(app.clipboard()).toBe("Clean the disk");
  expect(app.count(USER_CHECK)).toBe(1);
  expect(app.count(AGENT_CHECK)).toBe(0);
  await app.clock!.runFor(1300);
  expect(app.count("id:chat-copy-check")).toBe(0);
});

test("with reduced motion copy still copies and shows the check", async () => {
  const { app } = await openConsole({ location: CHAT, api: API, clock: true, reducedMotion: true });
  await app.waitFor("text:All done.");
  await app.press(AGENT_COPY);
  expect(app.clipboard()).toBe("All done.");
  expect(app.count(AGENT_CHECK)).toBe(1);
  await app.clock!.runFor(1300);
  expect(app.count("id:chat-copy-check")).toBe(0);
});
