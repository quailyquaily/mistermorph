import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";

import AppButton from "../components/ui/AppButton.js";

const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../views/ChatView.css", import.meta.url), "utf8");
const i18n = await readFile(new URL("../i18n/index.js", import.meta.url), "utf8");

// The TODO toggle exactly as ChatView's template has it.
const toggle = view.match(/<!-- Always there, also before any TODO item has run[^\n]*-->\s*(<AppButton[\s\S]*?<\/AppButton>)/u)?.[1];
assert.ok(toggle, "the TODO toggle is in ChatView's template");

// The labels as ChatView builds them, with a stand-in translation.
const t = (key, vars) => (vars ? `${key}:${vars.count}` : key);
function labels(view, count) {
  const label = count > 0 ? t("chat_topics_view_cron_running", { count }) : t("chat_topics_view_cron");
  const title = view !== "cron" ? label : count > 0 ? t("chat_topics_view_date_cron_running", { count }) : t("chat_topics_view_date");
  return { label, title };
}

async function renderToggle(topicSidebarView, cronRunning) {
  const { label, title } = labels(topicSidebarView, cronRunning);
  const app = Vue.createSSRApp({
    components: { AppButton, PhAlarm: { template: '<svg class="ph-alarm"></svg>' } },
    template: toggle,
    setup: () => ({ topicSidebarView, cronRunning, cronToggleLabel: label, cronToggleTitle: title, setTopicSidebarView() {} }),
  });
  return renderToString(app);
}

test("the TODO toggle shows running and selected apart, in all four combinations", async () => {
  for (const selected of [false, true]) {
    for (const count of [0, 1, 3]) {
      const html = await renderToggle(selected ? "cron" : "date", count);
      const name = `selected=${selected} running=${count}`;
      const button = html.match(/<button[^>]*>/u)[0];
      assert.equal(/\bis-active\b/u.test(button), selected, name);
      assert.equal(/\bis-running\b/u.test(button), count > 0, name);
      assert.match(button, new RegExp(`aria-pressed="${selected}"`, "u"), name);
      // Running is information, not a busy or disabled button.
      assert.doesNotMatch(button, /\sdisabled|aria-busy|aria-disabled/u, name);
      // The alarm stays; the mark is added beside it, hidden from assistive tech (the label says it).
      assert.match(html, /<span class="chat-topic-view-toggle-glyph"><svg class="ph-alarm icon"><\/svg>/u, name);
      assert.equal(html.includes('<span class="chat-topic-view-toggle-status" aria-hidden="true"></span>'), count > 0, name);
      const { label, title } = labels(selected ? "cron" : "date", count);
      assert.match(button, new RegExp(`aria-label="${label}"`, "u"), name);
      assert.match(button, new RegExp(`title="${title}"`, "u"), name);
    }
  }
  assert.match(toggle, /@click="setTopicSidebarView\(topicSidebarView === 'cron' \? 'date' : 'cron'\)"/u);
  // Always there and enabled: the button itself has no condition, disabled or loading state.
  assert.doesNotMatch(toggle.match(/<AppButton[^>]*>/u)[0], /:disabled|:loading|v-if|v-show/u);
});

test("the count comes from the whole activity snapshot, read again when the network returns", () => {
  assert.match(view, /const cronRunning = computed\(\(\) => cronRunningCount\(topicActivity\.value\)\);/u);
  assert.match(view, /cronRunning\.value > 0 \? t\("chat_topics_view_cron_running", \{ count: cronRunning\.value \}\) : t\("chat_topics_view_cron"\)/u);
  assert.match(view, /if \(topicSidebarView\.value !== "cron"\) return cronToggleLabel\.value;\s*return cronRunning\.value > 0 \? t\("chat_topics_view_date_cron_running", \{ count: cronRunning\.value \}\) : t\("chat_topics_view_date"\);/u);
  // No poll of its own: the topic activity poll feeds it.
  assert.equal(view.match(/"\/topics\/activity"/gu)?.length, 1);
  assert.match(view, /function onNetworkOnline\(\) \{\s*resumeTrackedTasks\(\);\s*void refreshTopicActivity\(\);\s*\}/u);
  assert.match(view, /window\.addEventListener\("online", onNetworkOnline\);/u);
  assert.match(view, /window\.removeEventListener\("online", onNetworkOnline\);/u);
});

test("the running mark is the topics' status mark on the icon, without moving the toolbar", () => {
  // The icon's box keeps the icon's size; the mark is positioned over it, not laid out beside it.
  assert.match(styles, /\.chat-topic-view-toggle-glyph \{\s*position: relative;\s*display: inline-flex;\s*width: 14px;\s*height: 14px;\s*\}/u);
  const mark = styles.match(/\.chat-topic-view-toggle-status \{([^}]*)\}/u)?.[1] || "";
  assert.match(mark, /position: absolute;/u);
  assert.match(mark, /width: var\(--status-mark-size\);\s*height: var\(--status-mark-size\);\s*border: 1px solid currentColor;\s*border-radius: 1px;\s*color: var\(--status-on\);/u);
  assert.match(mark, /pointer-events: none;/u);
  // The toggle's selected style sets no rule on the mark, so the two stay apart.
  assert.doesNotMatch(styles, /is-active[^{]*chat-topic-view-toggle-status/u);
  assert.match(styles, /\.chat-topic-view-toggle-status::after \{[^}]*animation: chat-topic-status-fill 0\.9s ease-in-out infinite alternate;/u);
  // Without motion it is the topics' static hollow mark.
  assert.match(styles, /prefers-reduced-motion: reduce\) \{\s*\.chat-topic-item-status\.is-running::after,\s*\.chat-topic-view-toggle-status::after \{\s*animation: none;\s*opacity: 0;/u);
});

test("the running labels are in every language and carry the count", () => {
  for (const key of ["chat_topics_view_cron_running", "chat_topics_view_date_cron_running"]) {
    const values = [...i18n.matchAll(new RegExp(`\\b${key}: "([^"]*)"`, "gu"))].map((m) => m[1]);
    assert.equal(values.length, 3, key);
    for (const value of values) assert.match(value, /\{count\}/u, `${key}: ${value}`);
  }
  assert.match(i18n, /chat_topics_view_cron_running: "TODO runs — \{count\} running"/u);
});
