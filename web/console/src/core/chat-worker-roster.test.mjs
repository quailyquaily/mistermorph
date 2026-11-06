import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";

import { normalizeActivity } from "./chat-task-history.js";
import { rosterWorkers, workerProcessLabel } from "./chat-workers.js";

const source = await readFile(new URL("../components/ChatWorkerRoster.js", import.meta.url), "utf8");
const history = await readFile(new URL("../components/ChatHistoryItem.js", import.meta.url), "utf8");
// Load the real component without its CSS and the application's translations.
const localeState = Vue.reactive({ lang: "en" });
const context = {
  ...Vue, rosterWorkers, workerProcessLabel, localeState,
  // The real module imports the SVG files, which only the bundler can load.
  workerAvatarURL: (style) => `/avatars/${style}.svg`,
  translate: (key, args) => `${key}${args ? `:${args.count}` : ""}`,
};
vm.runInNewContext(source.replace(/^import[^\n]*\n/gm, "").replace("export default", "globalThis.component ="), context);

const activity = normalizeActivity({
  workers: [
    { id: "worker-1", name: "Milo", kind: "subagent", status: "done", summary: "found it" },
    {
      id: "worker-2", name: "Nova", kind: "coder", status: "running", stream: "codex",
      output: "Codex is starting\nCodex is working\n  # step\n\t<b>raw</b> & more\n", processes: [{ pid: 4242, program: "codex", activity_id: "coder-1" }],
    },
  ],
  workers_omitted: 3,
});

async function render(props) {
  return renderToString(Vue.createSSRApp(context.component, props));
}

test("the roster is hidden for a task without workers", async () => {
  assert.equal(await render({ itemId: "t", activity: null, status: "done" }), "<!---->");
  assert.equal(await render({ itemId: "t", activity: normalizeActivity({ history: [{ id: "a", kind: "tool" }] }), status: "done" }), "<!---->");
});

test("each worker shows its avatar, name and state, with a count of dropped ones", async () => {
  const html = await render({ itemId: "t", activity, status: "running" });
  assert.equal((html.match(/<img class="chat-worker-avatar is-[a-z]+" src="\/avatars\/[a-z]+\.svg" alt aria-hidden="true" width="20" height="20"/gu) || []).length, 2);
  assert.match(html, /chat-worker-chip is-done[^>]*>[\s\S]*?Milo[\s\S]*?chat_worker_state_done/u);
  assert.match(html, /chat-worker-chip is-running[^>]*>[\s\S]*?Nova[\s\S]*?chat_worker_state_running/u);
  assert.match(html, /aria-pressed="false"/u);
  assert.match(html, /chat_workers_omitted:3/u);
  assert.doesNotMatch(html, /chat-worker-detail/u);
  // A worker keeps its avatar wherever it is drawn.
  const again = await render({ itemId: "other", activity, status: "done" });
  const avatars = (markup) => markup.match(/chat-worker-avatar is-[a-z]+/gu);
  assert.deepEqual(avatars(again), avatars(html));
});

test("switching the language renames workers everywhere and keeps their avatars and state", async () => {
  const component = context.component;
  const indexed = normalizeActivity({
    workers: [
      { id: "worker-1", name: "Ada", name_index: 9, avatar_index: 6, kind: "coder", status: "running" },
      { id: "worker-2", name: "Ada-2", name_index: 41, avatar_index: 1, kind: "subagent", status: "done" },
    ],
  });
  async function renderSelected(lang) {
    localeState.lang = lang;
    const app = Vue.createSSRApp({
      ...component,
      setup(props, ctx) {
        const state = component.setup(props, ctx);
        state.select({ id: "worker-1" });
        return state;
      },
    }, { itemId: "t", activity: indexed, status: "running" });
    return renderToString(app);
  }
  const names = (html) => [...html.matchAll(/class="chat-worker-name">([^<]*)</gu)].map((match) => match[1]);
  const looks = (html) => [...html.matchAll(/chat-worker-avatar is-([a-z]+)/gu)].map((match) => match[1]);
  const states = (html) => [...html.matchAll(/chat-worker-chip is-([a-z]+)/gu)].map((match) => match[1]);
  const en = await renderSelected("en");
  const zh = await renderSelected("zh");
  const ja = await renderSelected("ja");
  const back = await renderSelected("en");
  localeState.lang = "en";
  assert.deepEqual(names(en), ["Ada", "Ada-2"]);
  assert.deepEqual(names(zh), ["周涛", "周涛-2"]);
  assert.deepEqual(names(ja), ["加藤美咲", "加藤美咲-2"]);
  assert.equal(back, en);
  for (const html of [zh, ja]) {
    assert.deepEqual(looks(html), looks(en));
    assert.deepEqual(states(html), states(en));
  }
  assert.deepEqual(looks(en), ["denko", "night", "denko"]);
  // The chip title, the detail heading and the detail region all use the shown name.
  assert.match(zh, /title="周涛 · chat_worker_kind_coder · chat_worker_state_running"/u);
  assert.match(zh, /role="region" aria-label="周涛"/u);
  assert.match(zh, /chat-worker-detail-name">周涛</u);
  assert.doesNotMatch(zh, />Ada</u);
});

test("a worker still running in a finished task shows the task's ending", async () => {
  const html = await render({ itemId: "t", activity, status: "failed" });
  assert.match(html, /chat-worker-chip is-failed[^>]*>[\s\S]*?Nova/u);
});

test("selecting a worker shows its PIDs and its output as plain text", async () => {
  const component = context.component;
  const setup = component.setup;
  // Start with Nova selected, as a click would.
  const selectedComponent = {
    ...component,
    setup(props, ctx) {
      const state = setup(props, ctx);
      state.select({ id: "worker-2" });
      return state;
    },
  };
  const app = Vue.createSSRApp(selectedComponent, { itemId: "t", activity, status: "running" });
  const html = await renderToString(app);
  assert.match(html, /aria-pressed="true"[^>]*aria-controls="chat-worker-detail-t"|aria-controls="chat-worker-detail-t"[^>]*aria-pressed="true"/u);
  assert.match(html, /id="chat-worker-detail-t"/u);
  assert.match(html, /chat-worker-detail-pid">codex PID 4242</u);
  assert.match(html, /chat_worker_kind_coder/u);
  assert.ok(html.includes('<p class="chat-worker-output">Codex is starting\nCodex is working\n  # step\n\t&lt;b&gt;raw&lt;/b&gt; &amp; more\n</p>'));
  assert.doesNotMatch(html, /<b>raw/u);
  // A lone section needs no label.
  assert.doesNotMatch(html, /chat-worker-section-label/u);
});

test("a finished subagent shows its error and final result, each labelled", async () => {
  const component = context.component;
  const app = Vue.createSSRApp({
    ...component,
    setup(props, ctx) {
      const state = component.setup(props, ctx);
      state.select({ id: "worker-4" });
      return state;
    },
  }, {
    itemId: "t",
    activity: normalizeActivity({ workers: [{ id: "worker-4", name: "Juno", kind: "subagent", status: "failed", error: "model failed", result: "first line\nsecond line: answer 42" }] }),
    status: "done",
  });
  const html = await renderToString(app);
  assert.match(html, /chat-worker-section is-error[\s\S]*?chat_worker_section_error[\s\S]*?model failed/u);
  assert.match(html, /chat-worker-section is-result[\s\S]*?chat_worker_section_result[\s\S]*?first line\nsecond line: answer 42/u);
  assert.match(html, /chat-worker-detail-state is-failed/u);
});

test("a selected worker without output says so", async () => {
  const component = context.component;
  const app = Vue.createSSRApp({
    ...component,
    setup(props, ctx) {
      const state = component.setup(props, ctx);
      state.select({ id: "worker-3" });
      return state;
    },
  }, { itemId: "t", activity: normalizeActivity({ workers: [{ id: "worker-3", name: "Iris", kind: "subagent", status: "running" }] }), status: "running" });
  assert.match(await renderToString(app), /chat-worker-output is-empty">chat_worker_no_output</u);
});

test("chat history shows the roster for agent replies, apart from the status card", () => {
  assert.match(history, /import ChatWorkerRoster from "\.\/ChatWorkerRoster";/u);
  assert.match(history, /<ChatWorkerRoster\s+v-if="item\.activity\?\.workers\?\.length"/u);
  // It sits after the status card's v-if/v-else-if pair, so it shows without a status card too.
  const card = history.indexOf("</ChatStatusCard>");
  const roster = history.indexOf("<ChatWorkerRoster");
  const elseStatus = history.indexOf('v-else-if="statusText"');
  assert.ok(card < elseStatus && elseStatus < roster);
});
