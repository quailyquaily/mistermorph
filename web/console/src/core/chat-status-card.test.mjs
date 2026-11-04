import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";

const source = await readFile(new URL("../components/ChatStatusCard.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../components/ChatStatusCard.css", import.meta.url), "utf8");
// Load the real component without its CSS and application-wide translation dependencies.
const context = { ...Vue, translate: (key, args) => `${key}${args ? `:${args.count}` : ""}` };
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
  assert.match(detailsStyle, /max-height: min\(340px, 46vh\)/u);
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
