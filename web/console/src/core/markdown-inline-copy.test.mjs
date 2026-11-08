import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Inline code copying lives in the Markdown renderer. These tests run the code the Console ships
// (the vendored build) against a small fake DOM, and check the renderer's source says the same.
const bundle = await readFile(new URL("../vendor/markdown-renderer/index.js", import.meta.url), "utf8");
const rendererSource = await readFile(new URL("../../../markdown-renderer/src/index.js", import.meta.url), "utf8");
const bundleCSS = await readFile(new URL("../vendor/markdown-renderer/index.css", import.meta.url), "utf8");
const rendererCSS = await readFile(new URL("../../../markdown-renderer/src/styles.css", import.meta.url), "utf8");

function slice(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = text.indexOf(end, from);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return text.slice(from, to);
}

const shipped = {
  constants: slice(bundle, "var INLINE_COPY_FEEDBACK_DURATION_MS", "var SHIKI_THEME"),
  clipboard: slice(bundle, "function saveSelectionState(doc) {", "async function getShikiHighlighter"),
  inline: slice(bundle, "function isInlineCopyCode(code) {", "async function initializeMermaid"),
};

test("the vendored renderer and its source copy inline code the same way", () => {
  const source = {
    constants: slice(rendererSource, "const INLINE_COPY_FEEDBACK_DURATION_MS", "const SHIKI_THEME"),
    clipboard: slice(rendererSource, "function saveSelectionState(doc) {", "async function getShikiHighlighter"),
    inline: slice(rendererSource, "function isInlineCopyCode(code) {", "async function initializeMermaid"),
  };
  const asBundled = (text) => text.replace(/^const /gmu, "var ").replace(/\bstringValue\(/gu, "stringValue2(").trim();
  for (const key of Object.keys(shipped)) {
    assert.equal(asBundled(source[key]), shipped[key].trim(), key);
  }
  const rules = (css) =>
    [...css.matchAll(/(\.mmr-document code\.mmr-inline-copy\[data-copy-state=(?:"copied"|copied)\]\[data-copy-pulse="[12]"\])\s*\{([^}]*)\}/gu)].map(
      ([, selector, body]) => `${selector.replace('state="copied"', "state=copied")}{${body.trim()}}`,
    );
  assert.equal(rules(bundleCSS).length, 2);
  assert.deepEqual(rules(bundleCSS), rules(rendererCSS));
});

const INTERACTIVE = new Set(["a", "button", "summary", "label", "select", "textarea", "input"]);

class FakeElement {
  constructor(tag, { text = "", attrs = {}, classes = [], parent = null, doc = null } = {}) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.attrs = { ...attrs };
    this.classList = new Set(classes);
    this.classList.contains = this.classList.has;
    this.dataset = {};
    this.parentElement = parent;
    this.ownerDocument = doc || parent?.ownerDocument || null;
    this.listeners = {};
    this.children = [];
    this.isConnected = true;
    parent?.children.push(this);
  }
  matches(selector) {
    const tag = this.tagName.toLowerCase();
    return selector.split(",").some((part) => {
      const simple = part.trim();
      if (simple === tag) {
        return true;
      }
      if (simple === "[role='button']" || simple === "[role='link']") {
        return this.attrs.role === simple.slice(7, -2);
      }
      if (simple.startsWith("[contenteditable]")) {
        return "contenteditable" in this.attrs && this.attrs.contenteditable !== "false";
      }
      return false;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) {
        return node;
      }
    }
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName.toLowerCase() === selector) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  hasAttribute(name) {
    return name in this.attrs;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      button: 0,
      repeat: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    for (const fn of this.listeners[type] || []) {
      fn(event);
    }
    return event;
  }
  focus(options) {
    this.ownerDocument.focusLog.push([this, options]);
    this.ownerDocument.activeElement = this;
  }
}

function setup({ writeText = async () => {}, execResult = true } = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const written = [];
  const view = {
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const selection = {
    isCollapsed: true,
    ranges: [],
    get rangeCount() {
      return this.ranges.length;
    },
    getRangeAt(index) {
      return this.ranges[index];
    },
    removeAllRanges() {
      this.ranges = [];
      this.isCollapsed = true;
    },
    addRange(range) {
      this.ranges.push(range);
      this.isCollapsed = false;
    },
  };
  const docListeners = {};
  const doc = {
    defaultView: view,
    activeElement: null,
    focusLog: [],
    body: { append() {} },
    getSelection: () => selection,
    createElement(tag) {
      const field = new FakeElement(tag, { doc });
      field.style = {};
      field.select = () => {
        selection.ranges = [{ cloneRange: () => null, intersectsNode: () => false }];
        selection.isCollapsed = false;
      };
      field.setSelectionRange = () => {};
      field.remove = () => {
        field.isConnected = false;
      };
      return field;
    },
    execCommand: () => execResult,
    addEventListener(type, fn) {
      (docListeners[type] ||= new Set()).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners[type]?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(docListeners[type] || [])]) {
        fn({ type });
      }
    },
    docListeners,
  };
  const navigator = writeText
    ? {
        clipboard: {
          writeText: (text) => {
            written.push(text);
            return writeText(text);
          },
        },
      }
    : {};
  const context = { Element: FakeElement, navigator, window: view, String };
  vm.runInNewContext(
    `function stringValue2(value) { return typeof value === "string" ? value : String(value ?? ""); }
     function documentView(doc) { return doc?.defaultView || window; }
     ${shipped.constants}${shipped.clipboard}${shipped.inline}
     globalThis.api = { enhanceInlineCode, INLINE_COPY_FEEDBACK_DURATION_MS };`,
    context,
  );
  const article = new FakeElement("article", { doc });
  const paragraph = new FakeElement("p", { parent: article });
  const code = new FakeElement("code", { text: "pnpm build", parent: paragraph });
  return { api: context.api, article, code, doc, paragraph, selection, timers, view, written };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function runTimers(timers) {
  for (const [id, { fn }] of [...timers]) {
    timers.delete(id);
    fn();
  }
}

test("inline code becomes a copy control; fenced, linked, interactive, math and empty code do not", () => {
  const { api, article, code, paragraph, doc } = setup();
  const pre = new FakeElement("pre", { parent: article });
  const fenced = new FakeElement("code", { text: "pnpm test", parent: pre });
  const link = new FakeElement("a", { attrs: { href: "https://example.com" }, parent: paragraph });
  const linked = new FakeElement("code", { text: "link code", parent: link });
  const control = new FakeElement("span", { attrs: { role: "button" }, parent: paragraph });
  const inControl = new FakeElement("code", { text: "inside", parent: control });
  const math = new FakeElement("code", { text: "E=mc^2", classes: ["math-inline"], parent: paragraph });
  const empty = new FakeElement("code", { text: "  ", parent: paragraph });
  const editable = new FakeElement("div", { attrs: { contenteditable: "true" }, parent: article });
  const inEditable = new FakeElement("code", { text: "draft", parent: editable });
  api.enhanceInlineCode(article);

  assert.equal(code.getAttribute("role"), "button");
  assert.equal(code.getAttribute("tabindex"), "0");
  assert.equal(code.getAttribute("title"), "Click to copy");
  // The control is named by its text, so the code still reads as what it says.
  assert.equal(code.getAttribute("aria-label"), "Copy code: pnpm build");
  assert.ok(code.classList.has("mmr-inline-copy"));
  for (const node of [fenced, linked, inControl, math, empty, inEditable]) {
    assert.equal(node.getAttribute("role"), null, node.textContent);
    assert.equal(node.listeners.click, undefined, node.textContent);
  }
  assert.ok(doc);
});

test("a click copies the code's text, and shows copied only once the clipboard has it", async () => {
  let finish;
  const { api, article, code, written, timers } = setup({ writeText: () => new Promise((resolve) => (finish = resolve)) });
  api.enhanceInlineCode(article);
  const click = code.dispatch("click");
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.propagationStopped, true);
  assert.deepEqual(written, ["pnpm build"]);
  await settle();
  assert.equal(code.dataset.copyState, "", "no success before the clipboard confirms");
  finish();
  await settle();
  assert.equal(code.dataset.copyState, "copied");
  assert.equal(code.getAttribute("title"), "Copied");
  assert.equal(code.getAttribute("aria-label"), "Copied: pnpm build");
  assert.equal([...timers.values()][0].ms, api.INLINE_COPY_FEEDBACK_DURATION_MS);
  assert.ok(api.INLINE_COPY_FEEDBACK_DURATION_MS >= 1000);
  runTimers(timers);
  assert.equal(code.dataset.copyState, "");
  assert.equal(code.getAttribute("aria-label"), "Copy code: pnpm build");
});

test("repeated copies restart the feedback; enhancing again adds no second handler", async () => {
  const { api, article, code, written, timers } = setup();
  api.enhanceInlineCode(article);
  api.enhanceInlineCode(article);
  code.dispatch("click");
  await settle();
  assert.equal(written.length, 1);
  assert.equal(code.dataset.copyPulse, "1");
  code.dispatch("click");
  await settle();
  assert.equal(written.length, 2);
  assert.equal(code.dataset.copyState, "copied");
  assert.equal(code.dataset.copyPulse, "2");
  assert.equal(timers.size, 1, "the earlier reset is replaced");
  code.textContent = "pnpm build --watch";
  code.dispatch("click");
  await settle();
  assert.equal(written.at(-1), "pnpm build --watch", "the text is read when copied");
  assert.equal(code.dataset.copyPulse, "1");
});

test("a copy that fails says so and never shows copied", async () => {
  for (const options of [
    { writeText: () => Promise.reject(new Error("denied")), execResult: false },
    { writeText: null, execResult: false },
  ]) {
    const { api, article, code, timers } = setup(options);
    api.enhanceInlineCode(article);
    code.dispatch("click");
    await settle();
    assert.equal(code.dataset.copyState, "failed");
    assert.equal(code.getAttribute("title"), "Copy failed");
    assert.equal(code.getAttribute("aria-label"), "Copy failed: pnpm build");
    runTimers(timers);
    assert.equal(code.dataset.copyState, "");
  }
});

test("the copy-command fallback copies, then returns the focus and selection without scrolling", async () => {
  const { api, article, code, doc, selection } = setup({ writeText: null, execResult: true });
  api.enhanceInlineCode(article);
  const range = { cloneRange: () => range, intersectsNode: () => false };
  selection.addRange(range);
  code.focus();
  doc.focusLog.length = 0;
  code.dispatch("keydown", { key: "Enter" });
  await settle();
  assert.equal(code.dataset.copyState, "copied");
  assert.equal(doc.activeElement, code);
  assert.ok(doc.focusLog.every(([, options]) => options?.preventScroll === true));
  assert.deepEqual(selection.ranges, [range]);
});

test("Enter and Space copy from the keyboard; held keys and other keys do not", async () => {
  const { api, article, code, written } = setup();
  api.enhanceInlineCode(article);
  const enter = code.dispatch("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  const space = code.dispatch("keydown", { key: " " });
  assert.equal(space.defaultPrevented, true, "Space does not scroll the page");
  await settle();
  assert.equal(written.length, 2);
  const held = code.dispatch("keydown", { key: "Enter", repeat: true });
  assert.equal(held.defaultPrevented, true);
  const tab = code.dispatch("keydown", { key: "Tab" });
  assert.equal(tab.defaultPrevented, false);
  await settle();
  assert.equal(written.length, 2);
});

test("selecting text in the code keeps the selection instead of copying", async () => {
  const { api, article, code, doc, selection, timers, written } = setup();
  api.enhanceInlineCode(article);
  // A press takes the code out of the tab order so the browser can start a selection in it.
  code.dispatch("pointerdown", { button: 0 });
  assert.equal(code.hasAttribute("tabindex"), false);
  selection.addRange({ cloneRange() {}, intersectsNode: (node) => node === code });
  doc.dispatch("pointerup");
  const click = code.dispatch("click");
  await settle();
  assert.deepEqual(written, []);
  assert.equal(click.defaultPrevented, false);
  assert.equal(code.dataset.copyState, "");
  assert.equal(selection.rangeCount, 1);
  // The press is over: the code is reachable from the keyboard again.
  runTimers(timers);
  assert.equal(code.getAttribute("tabindex"), "0");
  assert.equal(doc.docListeners.pointerup.size, 0);

  // A selection elsewhere does not stop a click on the code from copying.
  selection.removeAllRanges();
  selection.addRange({ cloneRange() {}, intersectsNode: () => false });
  code.dispatch("click");
  await settle();
  assert.deepEqual(written, ["pnpm build"]);

  // Other buttons leave the tab order alone.
  code.dispatch("pointerdown", { button: 2 });
  assert.equal(code.getAttribute("tabindex"), "0");
});

test("the inline copy ring restarts by parity, draws no layout, and rests under reduced motion", () => {
  const keyframes = (name) => rendererCSS.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1];
  assert.ok(keyframes("mmr-inline-copy-ring"));
  assert.equal(keyframes("mmr-inline-copy-ring"), keyframes("mmr-inline-copy-ring-again"));
  assert.doesNotMatch(keyframes("mmr-inline-copy-ring"), /\b(?:width|height|margin|padding|outline|border)\s*:/u);
  for (const css of [rendererCSS, bundleCSS]) {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.mmr-document code\.mmr-inline-copy \{\s*transition: none;\s*\}\s*\.mmr-document code\.mmr-inline-copy\[data-copy-state=(?:"copied"|copied)\] \{\s*animation: none;/u);
  }
});
