import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeTopicMetadata } from "./topic-metadata-merge.js";

const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const icons = await readFile(new URL("../icons/phosphor.js", import.meta.url), "utf8");
const i18n = await readFile(new URL("../i18n/index.js", import.meta.url), "utf8");
const metadata = await readFile(new URL("./topic-metadata.js", import.meta.url), "utf8");

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

test("the sidebar and its TODO toggle stay when the only topics are TODO items'", () => {
  assert.match(view, /const hasSidebarTopics = computed\(\(\) => hasVisibleTopics\.value \|\| cronTopics\.value\.length > 0\);/u);
  // Nothing but hasSidebarTopics decides the layout by the person's own topics alone.
  assert.equal(view.match(/hasVisibleTopics\.value/gu)?.length, 1);
  // Desktop: the sidebar and its grid column. Phone: the topics pane and the way back to it.
  assert.match(view, /if \(!mobileTopicSplitEnabled\.value\) \{\s*return hasSidebarTopics\.value;\s*\}\s*return mobileTopicView\.value === "topics";/u);
  assert.match(view, /consoleTopicsEnabled\.value && hasSidebarTopics\.value && !mobileTopicSplitEnabled\.value\) \{\s*classes\.push\("has-sidebar"\);/u);
  assert.match(view, /mobileTopicSplitEnabled\.value && hasSidebarTopics\.value && mobileTopicView\.value === "chat"/u);
  assert.match(view, /function syncMobileTopicView\(options = \{\}\) \{[\s\S]*?if \(!hasSidebarTopics\.value\) \{\s*mobileTopicView\.value = "chat";/u);
  assert.match(view, /function showTopicsView\(\) \{\s*if \(!hasSidebarTopics\.value\) \{\s*return;/u);
});

test("a metadata poll brings a TODO topic's latest run time, which orders the TODO list", () => {
  assert.match(view, /useTopicMetadata\(topics, submitEndpointRef, \(topic\) => isCronTopicID\(topic\?\.id\)\);/u);
  assert.match(metadata, /return mergeTopicMetadata\(topic, updated\.get\(topic\.id\), followsActivity\(topic\)\);/u);

  const a = { id: "_cron_a", title: "A", title_revision: 1, tags: [], updated_at: "2026-11-05T09:00:00Z" };
  const ran = { ...a, updated_at: "2026-11-05T10:00:00Z" };
  // A ran again: its topic takes the new time, and so sorts above one that ran in between.
  const merged = mergeTopicMetadata(a, ran, true);
  assert.equal(merged.updated_at, "2026-11-05T10:00:00Z");
  const b = { id: "_cron_b", title: "B", title_revision: 1, tags: [], updated_at: "2026-11-05T09:30:00Z" };
  const latestFirst = [merged, b].sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
  assert.deepEqual(latestFirst.map((topic) => topic.id), ["_cron_a", "_cron_b"]);

  // The person's own topics keep the order they were loaded in, so the time alone changes nothing.
  assert.equal(mergeTopicMetadata(a, ran), a);
  // Nothing new, an older copy, or a topic the poll did not return: the topic itself comes back.
  assert.equal(mergeTopicMetadata(a, { ...a }, true), a);
  assert.equal(mergeTopicMetadata(ran, a, true), ran);
  assert.equal(mergeTopicMetadata({ ...a, title_revision: 2 }, { ...ran, title: "Old" }, true).title, "A");
  assert.equal(mergeTopicMetadata(a, undefined, true), a);
  // A rename still merges for every topic, with the newer time it came with.
  assert.deepEqual(mergeTopicMetadata(a, { ...ran, title: "A2", title_revision: 2 }), { ...ran, title: "A2", title_revision: 2 });
  assert.equal(mergeTopicMetadata(a, { ...a, tags: ["x"] }).tags[0], "x");
});
