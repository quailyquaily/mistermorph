// iOS's swipe back (lib/systemBack.ts `edgeSwipeBack`): the iPhone has no system Back, so a swipe in
// from the left edge of the screen is the app's own and runs what Back runs on Android: the page's
// back arrow. Only a rightward move from the edge is taken; taps and other drags are left alone,
// and nothing is taken where there is no back to go to.
import { expect, test } from "nsh/test";
import { claimsEdgeSwipe, edgeSwipeGoesBack, EDGE_SWIPE } from "../lib/systemBack";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const API = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } }, "GET /proxy:/todo/tasks": { body: { items: [] } } };

test("the swipe back: from the left edge, rightwards and mostly sideways; far enough or a flick", () => {
  const swipe = (x0: number, dx: number, dy = 0, vx = 0) => ({ x0, dx, dy, vx });
  expect(claimsEdgeSwipe(swipe(4, 20))).toBe(true);
  expect(claimsEdgeSwipe(swipe(EDGE_SWIPE.edge, 20, 6))).toBe(true);
  // Not from the edge, not yet past a tap's wobble, leftwards, or mostly up or down.
  expect(claimsEdgeSwipe(swipe(EDGE_SWIPE.edge + 1, 40))).toBe(false);
  expect(claimsEdgeSwipe(swipe(4, 8))).toBe(false);
  expect(claimsEdgeSwipe(swipe(4, -40))).toBe(false);
  expect(claimsEdgeSwipe(swipe(4, 20, 15))).toBe(false);

  expect(edgeSwipeGoesBack(swipe(4, EDGE_SWIPE.commit))).toBe(true);
  expect(edgeSwipeGoesBack(swipe(4, 40, 0, 800))).toBe(true);
  // A short slow one, or a flick too short, stays.
  expect(edgeSwipeGoesBack(swipe(4, 40, 0, 100))).toBe(false);
  expect(edgeSwipeGoesBack(swipe(4, 20, 0, 900))).toBe(false);
});

test("on the iPhone a drag that does not start at the left edge leaves the open topic as it was", async () => {
  const { app } = await openConsole({ platform: "ios", location: "/e/default/chat/topic-1", api: API });
  await app.waitFor("id:chat-back");
  await app.drag("id:chat-composer-input", { x: 160 });
  await app.wait(400);
  expect(app.shows("id:chat-back")).toBe(true);
});
