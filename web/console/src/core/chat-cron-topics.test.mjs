import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cronSidebarGroups, cronTopicsOf, isCronTopicID } from "./chat-cron-topics.js";
import { mergeTopicMetadata } from "./topic-metadata-merge.js";

const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const icons = await readFile(new URL("../icons/phosphor.js", import.meta.url), "utf8");
const i18n = await readFile(new URL("../i18n/index.js", import.meta.url), "utf8");
const metadata = await readFile(new URL("./topic-metadata.js", import.meta.url), "utf8");

test("TODO items' topics are kept out of the person's topic list", () => {
  assert.match(view, /import \{ cronSidebarGroups, cronTopicsOf, isCronTopicID \} from "\.\.\/core\/chat-cron-topics";/u);
  assert.equal(isCronTopicID(" _cron_weekly "), true);
  for (const id of ["_cron_", "cron_weekly", "_agentlink_a", "_awareness", "", null]) {
    assert.equal(isCronTopicID(id), false, String(id));
  }
  assert.match(view, /if \(isAgentLinkTopicID\(topicID\) \|\| isCronTopicID\(topicID\)\) \{\s*continue;\s*\}\s*items\.push\(topic\);/u);
  assert.match(view, /isAgentLinkTopicID\(normalizedTopicID\) \|\|\s*isCronTopicID\(normalizedTopicID\)\s*\) \{\s*return;\s*\}\s*rememberLastTopicID/u);
});

test("a toggle switches the topic list to the TODO items' topics only", () => {
  assert.match(view, /const cronTopics = computed\(\(\) => cronTopicsOf\(topics\.value\)\);/u);
  assert.match(view, /if \(topicSidebarView\.value === "cron"\) \{\s*return cronSidebarGroups\(topics\.value\);/u);
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

// The sidebar's own topics, as GET /topics returns them, with or without TODO items' topics.
const ownTopics = [
  { id: "01a1", title: "Trip plan", updated_at: "2026-11-05T08:00:00Z" },
  { id: "_agentlink_inst_b", title: "Other agent", updated_at: "2026-11-05T11:00:00Z" },
  { id: "_awareness", title: "Awareness", updated_at: "2026-11-05T12:00:00Z" },
];
const runTopics = [
  { id: "_cron_weekly", title: "Weekly report", updated_at: "2026-11-05T09:00:00Z" },
  { id: "_cron_nightly", title: "Nightly build", updated_at: "2026-11-05T10:00:00Z" },
];

// The toggle button of one sidebar view, from <AppButton to </AppButton>.
function toggleButton(viewName) {
  const click = view.indexOf(`@click="setTopicSidebarView(topicSidebarView === '${viewName}' ? 'date' : '${viewName}')"`);
  assert.notEqual(click, -1, viewName);
  return view.slice(view.lastIndexOf("<AppButton", click), view.indexOf("</AppButton>", click));
}

test("the TODO runs button is always in the sidebar, whether or not a TODO item has run", () => {
  const button = toggleButton("cron");
  assert.match(button, /<PhAlarm class="icon" \/>/u);
  assert.match(button, /:aria-label="t\('chat_topics_view_cron'\)"/u);
  // No condition at all, in particular none on the TODO items' topics.
  assert.doesNotMatch(button, /v-if|v-show|cronTopics/u);
  // The agents button, beside it, shows that the check sees a condition when there is one.
  assert.match(toggleButton("agents"), /v-if="agentTopics\.length > 0/u);
});

test("with no TODO run topic, the TODO view is empty and says so; it never lists other topics", () => {
  assert.deepEqual(cronTopicsOf(ownTopics), []);
  assert.deepEqual(cronSidebarGroups(ownTopics), []);
  for (const none of [[], null, undefined]) {
    assert.deepEqual(cronSidebarGroups(none), []);
  }
  // The empty note is tied to the view and to there being no TODO topic, and has its text.
  assert.match(view, /<p v-if="topicSidebarView === 'cron' && cronTopics\.length === 0" class="chat-topic-tags-hint">\s*\{\{ t\("chat_topics_cron_empty"\) \}\}/u);
  assert.match(i18n, /chat_topics_cron_empty: "No TODO item has run yet\. Once an item runs, /u);
  // Pressed again, the button goes back to the ordinary list, which keeps TODO topics out.
  assert.match(toggleButton("cron"), /:aria-pressed="topicSidebarView === 'cron' \? 'true' : 'false'"/u);
  assert.match(view, /topicSidebarView\.value = view === "tags" \|\| view === "agents" \|\| view === "cron" \? view : "date";/u);
});

test("with TODO run topics, the TODO view lists them only, the latest run first", () => {
  const groups = cronSidebarGroups([...ownTopics, ...runTopics]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "cron");
  assert.equal(groups[0].label, "");
  assert.deepEqual(groups[0].topics.map((topic) => topic.id), ["_cron_nightly", "_cron_weekly"]);
  // The loaded list is left as it was.
  assert.deepEqual(runTopics.map((topic) => topic.id), ["_cron_weekly", "_cron_nightly"]);
});
