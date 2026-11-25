// The iPhone app's frame (App.tsx, lib/systemInsets.ts `iosFrameInsets`): nsh draws the app under the
// status bar, so the frame keeps the pages below it and inside the side insets (a notch on its
// side); its bottom stays the keyboard's height, the home indicator's room being the navigation
// strip's and the pages' feet.
import { expect, test } from "nsh/test";
import { iosFrameInsets } from "../lib/systemInsets";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const API = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } }, "GET /proxy:/todo/tasks": { body: { items: [] } } };

test("the iPhone frame's padding: the status bar and the sides, and the keyboard at the bottom", () => {
  const notch = { top: 59, right: 0, bottom: 34, left: 0 };
  expect(iosFrameInsets(notch, 0)).toEqual({ top: 59, right: 0, bottom: 0, left: 0 });
  expect(iosFrameInsets(notch, 336)).toEqual({ top: 59, right: 0, bottom: 336, left: 0 });
  // On its side: the notch is a side inset, and the status bar is gone.
  expect(iosFrameInsets({ top: 0, right: 59, bottom: 21, left: 59 }, 0)).toEqual({ top: 0, right: 59, bottom: 0, left: 59 });
  expect(iosFrameInsets({}, 0)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});

// Headless runs report no padding (as tests/android.test.tsx checks Android's numbers): the app on
// an iPhone with a notch opens, its frame's bottom at 0 with the keyboard down.
test("the iPhone app opens with the frame's bottom at the keyboard's height", async () => {
  const { app } = await openConsole({
    platform: "ios",
    location: "/e/default/chat/topic-1",
    safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    api: API,
  });
  await app.waitFor("id:chat-composer-input");
  expect(app.count("id:app-frame.bottom-0")).toBe(1);
});
