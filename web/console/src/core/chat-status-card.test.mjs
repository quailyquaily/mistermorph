import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";
import { activityWorkerLabel } from "./chat-task-history.js";

const source = await readFile(new URL("../components/ChatStatusCard.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../components/ChatStatusCard.css", import.meta.url), "utf8");
// Load the real component without its CSS and application-wide translation dependencies.
const localeState = Vue.reactive({ lang: "en" });
const context = { ...Vue, activityWorkerLabel, localeState, translate: (key, args) => `${key}${args ? `:${args.count}` : ""}` };
vm.runInNewContext(source.replace(/^import[^\n]*\n/gm, "")
  .replace("export default", "globalThis.component ="), context);

async function renderEntry(entry, props = {}) {
  const app = Vue.createSSRApp(context.component, {
    activity: { current: { id: "coder", kind: "tool", name: "coder", status: "running", ...entry } },
    expandedPanel: "activity",
    ...props,
  });
  app.component("PhCaretDown", { render: () => null });
  return renderToString(app);
}

for (const stream of ["codex", "claude"]) {
  test(`${stream} progress preserves literal Markdown, escaped HTML and whitespace`, async () => {
    const output = '    # Heading\n\t**bold** & [link](https://example.com)\n\n```html\n<img src=x onerror="alert(1)">\n```\n  ';
    const html = await renderEntry({ stream, output, summary: "unused summary" });
    assert.ok(html.includes('<p class="chat-activity-note">    # Heading\n\t**bold** &amp; [link](https://example.com)\n\n```html\n&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\n```\n  </p>'));
    assert.doesNotMatch(html, /<(?:h1|strong|a|pre|code|img)\b|chat-activity-markdown|unused summary/u);
  });

  test(`${stream} progress keeps error priority, summary fallback and empty hiding`, async () => {
    const cases = [
      { entry: { error: "  failed <step>  ", output: "output", summary: "summary" }, note: "failed &lt;step&gt;" },
      { entry: { error: " \n", output: "  output\n", summary: "summary" }, note: "  output\n" },
      { entry: { output: " \n\t ", summary: "  summary  " }, note: "summary" },
      { entry: { output: "", summary: "summary" }, note: "summary" },
      { entry: { summary: "summary" }, note: "summary" },
      { entry: { error: "\t", output: " \n\t ", summary: " \n " }, note: null },
      { entry: {}, note: null },
    ];
    for (const { entry, note } of cases) {
      const html = await renderEntry({ stream, ...entry });
      const notes = [...html.matchAll(/<p class="chat-activity-note">([\s\S]*?)<\/p>/gu)].map((match) => match[1]);
      assert.deepEqual(notes, note === null ? [] : [note], JSON.stringify(entry));
    }
  });

  test(`${stream} children replace the parent note and retain child errors and omitted count`, async () => {
    const html = await renderEntry({
      stream,
      error: "parent error",
      output: "parent output",
      summary: "parent summary",
      childrenOmitted: 2,
      children: [null, { name: "bash", status: "failed", args: { command: "echo test" }, error: "child <error>" }],
    });
    assert.doesNotMatch(html, /parent (?:error|output|summary)/u);
    assert.match(html, /chat-activity-children/u);
    assert.match(html, /chat_activity_calls:3/u);
    assert.match(html, /chat_activity_calls_omitted:2/u);
    assert.match(html, /echo test/u);
    assert.match(html, /<p class="chat-activity-note">child &lt;error&gt;<\/p>/u);
    const withoutChildren = await renderEntry({ stream, output: "visible", children: [null] });
    assert.match(withoutChildren, /<p class="chat-activity-note">visible<\/p>/u);
  });
}

test("coder and ordinary activity share the wrapping monospace note and scroll container", async () => {
  const output = `    ${"long-output".repeat(200)}\n`.repeat(20);
  for (const entry of [{ name: "coder", stream: "codex" }, { name: "coder", stream: "claude" }, { name: "bash" }]) {
    const html = await renderEntry({ ...entry, output });
    assert.ok(html.includes(`<p class="chat-activity-note">${output}</p>`));
  }
  const noteStyle = styles.match(/\n\n\.chat-activity-note\s*\{([^}]+)\}/u)?.[1];
  assert.match(noteStyle, /font-family: var\(--font-mono\)/u);
  assert.match(noteStyle, /white-space: pre-wrap/u);
  assert.match(noteStyle, /overflow-wrap: anywhere/u);
  const detailsStyle = styles.match(/\n\n\.chat-status-details\s*\{([^}]+)\}/u)?.[1];
  assert.match(detailsStyle, /max-height: var\(--chat-status-details-max-height\)/u);
  assert.match(detailsStyle, /overflow: auto/u);
  assert.doesNotMatch(styles, /chat-activity-markdown|--mmr-|--md-code-bg|--chat-status-terminal-line/u);
  assert.doesNotMatch(source, /MarkdownContent/u);
});

test("collapsed progress stays hidden and the final assistant reply retains Markdown rendering", async () => {
  const html = await renderEntry({ stream: "codex", output: "hidden output" }, { expandedPanel: "" });
  assert.doesNotMatch(html, /hidden output|chat-status-details/u);
  const item = await readFile(new URL("../components/ChatHistoryItem.js", import.meta.url), "utf8");
  const richContent = await readFile(new URL("../components/ChatRichContent.js", import.meta.url), "utf8");
  assert.match(item, /<ChatRichContent\s+class="chat-history-markdown"\s+:source="item\.text"[^>]*format="auto"[^>]*theme="blueprint"/u);
  assert.match(richContent, /<MarkdownContent\s+v-if="segment\.kind === 'markdown'"[^>]*:source="segment\.source"/u);
});

test("activity entries name their worker in the Console's language", async () => {
  const worker = { id: "worker-1", name: "Luna", name_index: 1, avatar_index: 3, processes: [{ pid: 77, program: "codex", activity_id: "coder" }] };
  const names = {};
  for (const lang of ["en", "zh", "ja", "fr", "en"]) {
    localeState.lang = lang;
    const html = await renderEntry({ worker });
    names[lang] = html.match(/class="chat-activity-worker"> · ([^<]*)</u)[1];
  }
  localeState.lang = "en";
  assert.deepEqual(names, { en: "Luna · codex PID 77", zh: "林悦 · codex PID 77", ja: "鈴木葵 · codex PID 77", fr: "Luna · codex PID 77" });
});

test("the progress panel's dark surface does not depend on color-mix()", () => {
  const details = styles.match(/\n\.chat-status-details \{[\s\S]*?\n\}/u)?.[0] || "";
  assert.match(details, /\n {2}background-color: var\(--q-c-dark\);/u);
  assert.doesNotMatch(details, /\n {2}background:/u, "no shorthand that one unresolved color-mix() can void");
  const fallback = styles.match(/@supports not \(color: color-mix\([^)]*\)\) \{[\s\S]*?\n\}/u)?.[0] || "";
  for (const token of ["--chat-status-terminal-bg: var(--q-c-dark)", "--chat-status-terminal-fg: var(--q-c-white)", "--chat-status-terminal-muted: var(--q-c-dark-4)"]) {
    assert.ok(fallback.includes(token), token);
  }
});

test("the progress panel and the list scrolling inside it share one height bound", async () => {
  const rule = (selector) => styles.match(new RegExp(`(?:^|\\n)${selector.replaceAll(".", "\\.")}\\s*\\{([^}]+)\\}`, "u"))?.[1] || "";
  const card = rule(".chat-status-card");
  assert.match(card, /--chat-status-details-max-height: min\(340px, 46vh\)/u);
  assert.match(styles, /@supports \(height: 1svh\)\s*\{\s*\.chat-status-card\s*\{\s*--chat-status-details-max-height: min\(340px, 46svh\);/u);
  const shell = rule(".chat-status-details-shell");
  const details = rule(".chat-status-details");
  // The panel (its shell) and its scrolling list are capped by the same value, so whichever way a
  // browser sizes the shell's grid row, the dark box and the scrolled area end at the same edge.
  assert.match(shell, /max-height: var\(--chat-status-details-max-height\)/u);
  assert.match(shell, /overflow: hidden/u);
  assert.match(details, /max-height: var\(--chat-status-details-max-height\)/u);
  assert.match(details, /min-height: 0/u);
  assert.match(details, /overflow: auto/u);
  // Neither forces a height: short progress takes only its own.
  assert.doesNotMatch(`${shell}${details}`, /(?:^|[^-])height:|min-height: [1-9]/u);
});

test("an expanded panel with nothing to list draws no empty box", async () => {
  const app = (props) => {
    const instance = Vue.createSSRApp(context.component, props);
    instance.component("PhCaretDown", { render: () => null });
    return renderToString(instance);
  };
  const emptyPlan = await app({ plan: { steps: [] }, expandedPanel: "plan" });
  assert.doesNotMatch(emptyPlan, /chat-status-details/u);
  const plan = await app({ plan: { steps: [{ step: "Read", status: "completed" }] }, expandedPanel: "plan" });
  assert.match(plan, /class="chat-status-details"/u);
  assert.match(plan, /Read/u);
});

test("a panel following its latest entry keeps following when its height changes", async () => {
  const observed = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observed.push(this);
    }
    observe(node) {
      this.node = node;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  // A DOM node, as Vue holds it: not made reactive.
  const node = Vue.markRaw({ scrollHeight: 1000, clientHeight: 340, scrollTop: 660 });
  const resizeContext = { ...context, ResizeObserver: FakeResizeObserver };
  vm.runInNewContext(source.replace(/^import[^\n]*\n/gm, "").replace("export default", "globalThis.component ="), resizeContext);
  const definition = resizeContext.component;
  const warn = console.warn;
  console.warn = () => {}; // Lifecycle hooks registered outside a component only warn.
  const scope = Vue.effectScope();
  let state;
  try {
    state = scope.run(() =>
      definition.setup(
        { itemId: "a", activity: { current: { id: "x", kind: "tool", name: "bash", status: "running" } }, expandedPanel: "activity", hasReasoning: false, plan: null, status: "" },
        { emit() {} },
      ),
    );
  } finally {
    console.warn = warn;
  }
  state.detailsRef.value = node;
  await Vue.nextTick();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].node, node);
  // The window shrinks the panel: it was at the bottom, so it is kept there.
  node.clientHeight = 230;
  observed[0].callback();
  assert.equal(node.scrollTop, 1000);
  // The reader scrolls up; a later resize leaves the position alone.
  node.scrollTop = 120;
  state.rememberDetailsPinned();
  node.clientHeight = 340;
  observed[0].callback();
  assert.equal(node.scrollTop, 120);
  // The panel closes: its observer goes with it.
  state.detailsRef.value = null;
  await Vue.nextTick();
  assert.equal(observed[0].disconnected, true);
  scope.stop();
});
