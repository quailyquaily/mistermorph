import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";

import { normalizeActivity } from "./chat-task-history.js";
import { rosterWorkers, workerAvatar, workerProcessLabel } from "./chat-workers.js";

const source = await readFile(new URL("../components/ChatWorkerRoster.js", import.meta.url), "utf8");
const history = await readFile(new URL("../components/ChatHistoryItem.js", import.meta.url), "utf8");
// Load the real component without its CSS and the application's translations.
const context = {
  ...Vue, rosterWorkers, workerAvatar, workerProcessLabel,
  translate: (key, args) => `${key}${args ? `:${args.count}` : ""}`,
};
vm.runInNewContext(source.replace(/^import[^\n]*\n/gm, "").replace("export default", "globalThis.component ="), context);

const activity = normalizeActivity({
  workers: [
    { id: "worker-1", name: "Milo", kind: "subagent", status: "done", summary: "found it" },
    {
      id: "worker-2", name: "Nova", kind: "coder", status: "running", stream: "codex",
      output: "# step\n<b>raw</b> & more\n", processes: [{ pid: 4242, program: "codex", activity_id: "coder-1" }],
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
  assert.equal((html.match(/class="chat-worker-avatar"/gu) || []).length, 2);
  assert.match(html, /chat-worker-chip is-done[^>]*>[\s\S]*?Milo[\s\S]*?chat_worker_state_done/u);
  assert.match(html, /chat-worker-chip is-running[^>]*>[\s\S]*?Nova[\s\S]*?chat_worker_state_running/u);
  assert.match(html, /aria-pressed="false"/u);
  assert.match(html, /chat_workers_omitted:3/u);
  assert.doesNotMatch(html, /chat-worker-detail/u);
  // The same name draws the same avatar in every task.
  const again = await render({ itemId: "other", activity, status: "done" });
  const cells = (markup) => markup.match(/<svg class="chat-worker-avatar"[\s\S]*?<\/svg>/u)[0];
  assert.equal(cells(again), cells(html));
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
  assert.ok(html.includes('<p class="chat-worker-output"># step\n&lt;b&gt;raw&lt;/b&gt; &amp; more\n</p>'));
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
