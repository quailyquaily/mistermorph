import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HISTORY_LAYOUT_SETTLE_MS,
  HISTORY_SCROLL_INTENT_MS,
  createHistoryFollower,
  historyAtBottom,
} from "./chat-history-follow.js";

// A scrolling history viewport: scrollTop clamps to the content like a browser's does.
function fakeViewport({ scrollHeight = 3000, clientHeight = 700, atBottom = true } = {}) {
  const node = {
    clientHeight,
    _scrollHeight: scrollHeight,
    _scrollTop: 0,
    smoothScrolls: 0,
    get scrollHeight() {
      return this._scrollHeight;
    },
    set scrollHeight(value) {
      this._scrollHeight = value;
      this.scrollTop = this._scrollTop;
    },
    get scrollTop() {
      return this._scrollTop;
    },
    set scrollTop(value) {
      this._scrollTop = Math.max(0, Math.min(value, this._scrollHeight - this.clientHeight));
    },
    scrollTo({ top }) {
      this.smoothScrolls += 1;
      this.scrollTop = top;
    },
  };
  node.scrollTop = atBottom ? scrollHeight : 0;
  return node;
}

// Drives the follower with manual render ticks, animation frames, timers and clock.
function harness(options = {}) {
  const node = options.node || fakeViewport(options);
  const following = { value: options.following ?? true };
  const ticks = [];
  const frames = [];
  const timers = new Map();
  let timerID = 0;
  let clock = 10_000;
  let scope = options.scope || "topic-a";
  let viewport = node;
  const follower = createHistoryFollower({
    viewport: () => viewport,
    following,
    scope: () => scope,
    nextTick: (fn) => ticks.push(fn),
    frame: (fn) => frames.push(fn),
    delay: (fn, ms) => {
      timerID += 1;
      timers.set(timerID, { fn, at: clock + ms });
      return timerID;
    },
    cancelDelay: (id) => timers.delete(id),
    now: () => clock,
    reducedMotion: () => false,
  });
  const h = {
    node,
    following,
    follower,
    get pendingTimers() {
      return timers.size;
    },
    setScope(next) {
      scope = next;
    },
    setViewport(next) {
      viewport = next;
    },
    // Runs pending render ticks, then pending frames, as the browser would.
    flushTicks() {
      for (const fn of ticks.splice(0)) fn();
    },
    flushFrames() {
      for (const fn of frames.splice(0)) fn();
    },
    flush() {
      while (ticks.length || frames.length) {
        h.flushTicks();
        h.flushFrames();
      }
    },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    // The reader drags or flicks the view by delta (negative is up).
    userScroll(delta) {
      follower.markIntent();
      node.scrollTop += delta;
      follower.handleScroll();
    },
    // A background update: a TODO topic refresh, a poll or stream frame, a Markdown render.
    backgroundUpdate() {
      follower.scrollToBottom();
      follower.handleContentRendered();
      h.flush();
    },
  };
  return h;
}

test("an open progress panel keeps its place through background updates", () => {
  const h = harness();
  const scrollTopBefore = h.node.scrollTop;
  // The reader opens a panel near the bottom: it grows by 346px with no scroll event.
  h.follower.holdForLayoutChange();
  h.node.scrollHeight += 346;
  // Updates during the open transition and after it settles leave the view where it is.
  h.backgroundUpdate();
  assert.equal(h.node.scrollTop, scrollTopBefore);
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, false, "the bottom left the view, so the view no longer follows");
  for (let i = 0; i < 5; i++) {
    h.advance(5000);
    h.backgroundUpdate();
  }
  assert.equal(h.node.scrollTop, scrollTopBefore, "the opened panel stays where the reader opened it");
});

test("without a hold, the same layout change is followed to the bottom", () => {
  // What every progress toggle did before toggles held the view: a stale follow flag pulled the
  // opened panel away on the next background update.
  const h = harness();
  const scrollTopBefore = h.node.scrollTop;
  h.node.scrollHeight += 346;
  h.backgroundUpdate();
  assert.equal(h.node.scrollTop, scrollTopBefore + 346);
});

test("reading older messages is not interrupted by background updates or panel toggles", () => {
  const h = harness();
  h.userScroll(-1600);
  assert.equal(h.following.value, false);
  const readingAt = h.node.scrollTop;
  for (let i = 0; i < 3; i++) {
    h.node.scrollHeight += 40; // a running task's activity grows below
    h.backgroundUpdate();
  }
  assert.equal(h.node.scrollTop, readingAt);
  // Open and close a panel in the older message being read.
  h.follower.holdForLayoutChange();
  h.node.scrollHeight += 300;
  h.backgroundUpdate();
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  h.follower.holdForLayoutChange();
  h.node.scrollHeight -= 300;
  h.backgroundUpdate();
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, false);
  h.backgroundUpdate();
  assert.equal(h.node.scrollTop, readingAt);
});

test("closing a panel at the bottom, or scrolling back down, follows the bottom again", () => {
  const h = harness();
  h.follower.holdForLayoutChange();
  h.node.scrollHeight += 300;
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, false);
  // The reader scrolls down to the bottom: following resumes.
  h.userScroll(300);
  assert.equal(h.following.value, true);
  h.node.scrollHeight += 120; // a new run arrives
  h.backgroundUpdate();
  assert.ok(historyAtBottom(h.node));
  // Closing the panel at the bottom: the content shrinks, the view stays at the bottom and follows.
  h.follower.holdForLayoutChange();
  h.node.scrollHeight -= 300;
  h.follower.handleScroll(); // the clamp's scroll event
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, true);
  h.node.scrollHeight += 200;
  h.backgroundUpdate();
  assert.ok(historyAtBottom(h.node));
});

test("a view at the bottom keeps following new content", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.node.scrollHeight += 250;
    h.backgroundUpdate();
    assert.ok(historyAtBottom(h.node));
    assert.equal(h.following.value, true);
  }
  // A layout scroll (no reader intent) away from the bottom does not stop following.
  h.node.scrollTop -= 200;
  h.follower.handleScroll();
  assert.equal(h.following.value, true);
  h.backgroundUpdate();
  assert.ok(historyAtBottom(h.node));
});

test("a short history that does not scroll keeps following after a toggle", () => {
  const h = harness({ scrollHeight: 400, clientHeight: 700 });
  h.follower.holdForLayoutChange();
  h.node.scrollHeight = 600;
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, true);
  h.node.scrollHeight = 1400; // the first run's reply grows past the viewport
  h.backgroundUpdate();
  assert.ok(historyAtBottom(h.node));
});

test("a deferred scroll yields to a reader who starts scrolling before it runs", () => {
  const h = harness();
  h.node.scrollHeight += 200;
  h.follower.scrollToBottom();
  h.flushTicks(); // render done, the scroll waits for the next frame
  h.userScroll(-500);
  h.flushFrames();
  assert.equal(h.following.value, false);
  assert.equal(h.node.scrollTop, h.node.scrollHeight - h.node.clientHeight - 200 - 500);
});

test("a deferred scroll yields to a reader who scrolls before the render tick", () => {
  const h = harness();
  h.follower.handleContentRendered();
  h.userScroll(-500);
  const readingAt = h.node.scrollTop;
  h.flush();
  assert.equal(h.node.scrollTop, readingAt);
});

test("deferred scrolls and settle checks from another topic are dropped", () => {
  const h = harness();
  h.follower.scrollToBottom({ force: true });
  h.flushTicks();
  h.setScope("topic-b");
  const next = fakeViewport({ atBottom: false });
  h.setViewport(next);
  h.flushFrames();
  assert.equal(next.scrollTop, 0, "topic b's view is not scrolled by topic a's request");

  const g = harness();
  g.follower.holdForLayoutChange();
  g.setScope("topic-b");
  g.following.value = true; // topic b's load starts at its bottom
  g.node.scrollTop = 0;
  g.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(g.following.value, true, "topic a's settle check does not stop topic b following");
});

test("a newly loaded history starts at its bottom, even when the previous one did not follow", () => {
  const h = harness({ following: false, atBottom: false });
  h.follower.scrollToBottom({ force: true });
  h.flush();
  assert.ok(historyAtBottom(h.node));
  assert.equal(h.following.value, true);
});

test("a new toggle replaces the pending settle check", () => {
  const h = harness();
  h.follower.holdForLayoutChange();
  h.advance(HISTORY_LAYOUT_SETTLE_MS - 10);
  h.follower.holdForLayoutChange();
  assert.equal(h.pendingTimers, 1);
  h.node.scrollHeight += 300;
  h.advance(10);
  assert.equal(h.following.value, false, "the first check did not run mid-transition");
  h.advance(HISTORY_LAYOUT_SETTLE_MS);
  assert.equal(h.following.value, false);
  h.follower.dispose();
  assert.equal(h.pendingTimers, 0);
});

test("scroll intent expires", () => {
  const h = harness();
  h.follower.markIntent();
  assert.equal(h.follower.hasRecentIntent(), true);
  h.advance(HISTORY_SCROLL_INTENT_MS + 1);
  assert.equal(h.follower.hasRecentIntent(), false);
});

test("ChatView holds the view on a progress toggle and routes scrolls through the follower", async () => {
  const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const toggle = view.match(/function toggleChatStatus\(itemID, panel\) \{[\s\S]*?\n {4}\}/u)?.[0] || "";
  assert.match(toggle, /historyFollower\.holdForLayoutChange\(\);\s*chatStatusExpandedState\.value = nextState;/u);
  assert.match(view, /function handleMarkdownRendered\(\) \{\s*historyFollower\.handleContentRendered\(\);\s*\}/u);
  assert.match(view, /function handleHistoryScroll\(\) \{\s*historyFollower\.handleScroll\(\);\s*\}/u);
  assert.doesNotMatch(view, /historyUserScrollIntentAt/u);
});
