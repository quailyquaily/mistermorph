import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const icons = await readFile(new URL("../icons/phosphor.js", import.meta.url), "utf8");
const i18n = await readFile(new URL("../i18n/index.js", import.meta.url), "utf8");

test("TODO items' topics are kept out of the person's topic list", () => {
  assert.match(view, /const CRON_TOPIC_PREFIX = "_cron_";/u);
  assert.match(view, /if \(isAgentLinkTopicID\(topicID\) \|\| isCronTopicID\(topicID\)\) \{\s*continue;\s*\}\s*items\.push\(topic\);/u);
  assert.match(view, /isAgentLinkTopicID\(normalizedTopicID\) \|\|\s*isCronTopicID\(normalizedTopicID\)\s*\) \{\s*return;\s*\}\s*rememberLastTopicID/u);
});

test("a toggle switches the topic list to the TODO items' topics only", () => {
  assert.match(view, /if \(topicSidebarView\.value === "cron"\) \{\s*return cronTopics\.value\.length > 0 \? \[\{ key: "cron", label: "", topics: cronTopics\.value \}\] : \[\];/u);
  assert.match(view, /v-if="cronTopics\.length > 0 \|\| topicSidebarView === 'cron'"/u);
  assert.match(view, /@click="setTopicSidebarView\(topicSidebarView === 'cron' \? 'date' : 'cron'\)"/u);
  assert.match(view, /view === "tags" \|\| view === "agents" \|\| view === "cron" \? view : "date"/u);
  assert.match(view, /<PhAlarm v-else-if="isCronTopicID\(topic\.id\)" class="chat-topic-item-icon is-cron"/u);
  assert.match(icons, /PhAlarm,[\s\S]*const sources = \{\s*PhAlarm,/u);
});

test("a TODO item's topic is titled after the item, read-only, and follows new runs", () => {
  assert.match(view, /if \(isCronTopicID\(topicID\)\) \{\s*return String\(topic\?\.title \|\| ""\)\.trim\(\) \|\| t\("chat_topic_cron_untitled"\);/u);
  assert.match(view, /selectedTopicIsAgent\.value \|\|\s*selectedTopicIsCron\.value/u);
  assert.match(view, /<p v-else-if="!showChatPlaceholder && selectedTopicIsCron" class="chat-agent-topic-note">/u);
  assert.match(view, /\(normalizeTopicID\(selectedTopicID\.value\) === AWARENESS_TOPIC_ID \|\| selectedTopicIsCron\.value\) &&/u);
  for (const key of ["chat_topics_view_cron", "chat_topics_cron_empty", "chat_topic_cron_untitled", "chat_topic_cron_readonly"]) {
    assert.equal(i18n.match(new RegExp(`\\b${key}:`, "gu"))?.length, 3, key);
  }
});
