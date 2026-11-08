import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COPY_FEEDBACK_DURATION_MS, createCopyFeedback, writeClipboardText } from "./chat-copy-feedback.js";

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimer(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    runAll() {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

function fakeDocument({ execResult = true } = {}) {
  const log = [];
  const active = {
    isConnected: true,
    focus(options) {
      log.push(["focus-back", options]);
    },
  };
  const range = { cloneRange: () => range };
  const selection = {
    ranges: [range],
    get rangeCount() {
      return this.ranges.length;
    },
    getRangeAt(index) {
      return this.ranges[index];
    },
    removeAllRanges() {
      this.ranges = [];
    },
    addRange(next) {
      this.ranges.push(next);
    },
  };
  const doc = {
    activeElement: active,
    body: {
      appendChild(node) {
        log.push(["append", node.value]);
        node.parent = this;
      },
    },
    createElement() {
      return {
        style: {},
        setAttribute() {},
        focus(options) {
          log.push(["focus-field", options]);
          doc.activeElement = this;
        },
        select() {
          log.push(["select"]);
          selection.ranges = [{ cloneRange: () => null }];
        },
        remove() {
          log.push(["remove"]);
        },
      };
    },
    execCommand(command) {
      log.push(["exec", command]);
      if (execResult instanceof Error) {
        throw execResult;
      }
      return execResult;
    },
    getSelection: () => selection,
  };
  return { active, doc, log, range, selection };
}

test("the Clipboard API copies the message text as written", async () => {
  const written = [];
  await writeClipboardText("Run `pnpm build`", { navigator: { clipboard: { writeText: async (text) => written.push(text) } }, document: {} });
  assert.deepEqual(written, ["Run `pnpm build`"]);
});

test("the copy-command fallback succeeds only when the command reports a copy", async () => {
  for (const nav of [{}, { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } }]) {
    const ok = fakeDocument({ execResult: true });
    await writeClipboardText("hello", { navigator: nav, document: ok.doc });
    assert.deepEqual(ok.log.map(([step]) => step), ["append", "focus-field", "select", "exec", "remove", "focus-back"]);
    // The field takes focus without scrolling, and the reader's focus and selection come back.
    assert.deepEqual(ok.log[1][1], { preventScroll: true });
    assert.deepEqual(ok.log.at(-1)[1], { preventScroll: true });
    assert.deepEqual(ok.selection.ranges, [ok.range]);

    for (const execResult of [false, null, new Error("blocked")]) {
      const failed = fakeDocument({ execResult });
      await assert.rejects(writeClipboardText("hello", { navigator: nav, document: failed.doc }));
      assert.ok(failed.log.some(([step]) => step === "remove"), "the hidden field is always removed");
      assert.deepEqual(failed.selection.ranges, [failed.range]);
    }
  }
  await assert.rejects(writeClipboardText("hello", { navigator: {}, document: {} }));
});

test("a successful copy shows the copied state, restarts it on a repeat and then clears it", async () => {
  const timers = fakeTimers();
  const states = [];
  const feedback = createCopyFeedback({ apply: (state) => states.push(state), ...timers });

  assert.equal(await feedback.copy("a1", async () => {}), true);
  assert.deepEqual(states.at(-1), { id: "a1", pulse: 1 });
  assert.equal([...timers.pending.values()][0].ms, COPY_FEEDBACK_DURATION_MS);

  // A repeat while the check still shows raises the pulse, which restarts the animation, and the
  // copied state lasts its full time again from this copy.
  assert.equal(await feedback.copy("a1", async () => {}), true);
  assert.deepEqual(states.at(-1), { id: "a1", pulse: 2 });
  assert.equal(timers.pending.size, 1);

  timers.runAll();
  assert.deepEqual(states.at(-1), { id: "", pulse: 2 });
  assert.equal(await feedback.copy("a2", async () => {}), true);
  assert.deepEqual(states.at(-1), { id: "a2", pulse: 3 });
});

test("a failed copy never shows the copied state", async () => {
  const timers = fakeTimers();
  const states = [];
  const feedback = createCopyFeedback({ apply: (state) => states.push(state), ...timers });
  await feedback.copy("a1", async () => {});
  assert.equal(await feedback.copy("a1", async () => Promise.reject(new Error("denied"))), false);
  assert.deepEqual(states.at(-1), { id: "", pulse: 1 });
  assert.equal(timers.pending.size, 0);
  assert.ok(states.every((state) => state.id === "" || state.pulse === 1));
});

test("only the latest copy settles the state, and a reset drops one still in flight", async () => {
  const timers = fakeTimers();
  const states = [];
  const feedback = createCopyFeedback({ apply: (state) => states.push(state), ...timers });
  let finishFirst;
  const first = feedback.copy("a1", () => new Promise((resolve) => (finishFirst = resolve)));
  await feedback.copy("a2", async () => {});
  finishFirst();
  assert.equal(await first, false);
  assert.deepEqual(states, [{ id: "a2", pulse: 1 }]);

  let finishLate;
  const late = feedback.copy("a3", () => new Promise((resolve) => (finishLate = resolve)));
  feedback.reset();
  finishLate();
  assert.equal(await late, false);
  assert.deepEqual(states.at(-1), { id: "", pulse: 1 });
  assert.equal(timers.pending.size, 0);
});

test("the bubble's copy button restarts its animation on every copy without moving the bubble", async () => {
  const item = await readFile(new URL("../components/ChatHistoryItem.js", import.meta.url), "utf8");
  const list = await readFile(new URL("../components/ChatHistoryList.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../views/ChatView.css", import.meta.url), "utf8");

  assert.match(view, /historyCopyFeedback\.copy\(item\?\.id, \(\) => writeClipboardText\(text\)\)/u);
  assert.match(view, /:copied-pulse="copiedHistoryPulse"/u);
  assert.match(list, /:copy-pulse="copied\(item\) \? copiedPulse : 0"/u);
  assert.match(item, /v-memo="\[item, arriving, copied, copyPulse,/u);
  assert.match(item, /is-copied \$\{props\.copyPulse % 2 === 0 \? "is-copied-even" : "is-copied-odd"\}/u);

  const keyframes = (name) => css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1];
  for (const [name, again] of [
    ["chat-history-copy-pop", "chat-history-copy-pop-again"],
    ["chat-history-copy-ring", "chat-history-copy-ring-again"],
    ["chat-history-check-draw", "chat-history-check-draw-again"],
    ["chat-history-copy-flash", "chat-history-copy-flash-again"],
  ]) {
    assert.ok(keyframes(name), name);
    // Identical frames under two names: switching between them is what restarts the animation.
    assert.equal(keyframes(name), keyframes(again), again);
    assert.match(css, new RegExp(`\\.is-copied-odd[^{]*\\{\\s*animation: ${name} `, "u"));
    assert.match(css, new RegExp(`\\.is-copied-even[^{]*\\{\\s*animation: ${again} `, "u"));
    // Only transform, opacity, shadow, colour and stroke change: nothing that moves the layout.
    assert.doesNotMatch(keyframes(name), /\b(?:width|height|margin|padding|top|left|inset)\s*:/u);
  }
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-history-copy-action\.is-copied-odd([\s\S]*?)\n\}/u)?.[0];
  assert.ok(reduced, "reduced motion has its own copy feedback");
  assert.match(reduced, /animation: chat-history-copy-flash /u);
  assert.match(reduced, /\.chat-history-copy-action\.is-copied::after,\s*\.chat-history-copy-action\.is-copied \.chat-history-copied-icon path \{\s*animation: none;/u);
  assert.doesNotMatch(css.slice(css.indexOf(".chat-history-copy-action {"), css.indexOf(".chat-history-status {")), /--q-c-accent/u);
});
