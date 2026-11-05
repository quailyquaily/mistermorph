import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  activeChannelTab,
  channelTabs,
  channelTitle,
  itemsForChannelTab,
  longestChannelTab,
} from "./channel-tabs.js";

const items = [
  { id: "a", channel: "slack" },
  { id: "b", channel: "Telegram" },
  { id: "c", channel: "telegram" },
  { id: "d", channel: "matrix" },
];

test("channelTabs lists each channel that has an item, in a fixed order", () => {
  const tabs = channelTabs(items, { icon: (channel) => `icon-${channel}` });
  assert.deepEqual(tabs, [
    { id: "telegram", title: "Telegram", icon: "icon-telegram" },
    { id: "slack", title: "Slack", icon: "icon-slack" },
    { id: "matrix", title: "Matrix", icon: "icon-matrix" },
  ]);
});

test("channelTabs has nothing to split with fewer than two channels", () => {
  assert.deepEqual(channelTabs([]), []);
  assert.deepEqual(channelTabs(null), []);
  assert.deepEqual(channelTabs([{ channel: "slack" }, { channel: "slack" }, {}]), []);
});

test("itemsForChannelTab keeps one channel's items, or every item when there is no tab", () => {
  assert.deepEqual(itemsForChannelTab(items, "telegram").map((item) => item.id), ["b", "c"]);
  assert.deepEqual(itemsForChannelTab(items, "line"), []);
  assert.equal(itemsForChannelTab(items, "").length, 4);
  assert.equal(itemsForChannelTab(items, undefined).length, 4);
  assert.deepEqual(itemsForChannelTab(null, "telegram"), []);
});

test("activeChannelTab falls back to the first tab when the chosen channel has gone", () => {
  const tabs = channelTabs(items);
  assert.equal(activeChannelTab(tabs, "slack").id, "slack");
  assert.equal(activeChannelTab(tabs, "line").id, "telegram");
  assert.equal(activeChannelTab(tabs, "").id, "telegram");
  assert.equal(activeChannelTab([], "slack"), null);
});

test("longestChannelTab counts the fullest tab, or every item without tabs", () => {
  assert.equal(longestChannelTab(items, channelTabs(items)), 2);
  assert.equal(longestChannelTab([{ channel: "slack" }, { channel: "slack" }, { channel: "slack" }], []), 3);
  assert.equal(longestChannelTab(null, []), 0);
});

test("channelTitle names known channels and capitalises the rest", () => {
  assert.equal(channelTitle("line"), "LINE");
  assert.equal(channelTitle(" WeChat "), "WeChat");
  assert.equal(channelTitle("matrix"), "Matrix");
  assert.equal(channelTitle(""), "");
});

test("the conversation picker shows channel tabs above its list", async () => {
  const editor = await readFile(new URL("../components/AppMarkdownEditor.js", import.meta.url), "utf8");
  const menu = await readFile(new URL("../components/ui/AppDropdownMenu.js", import.meta.url), "utf8");
  const tabs = await readFile(new URL("../components/AppTabs.js", import.meta.url), "utf8");
  const tabStyles = await readFile(new URL("../components/AppTabs.css", import.meta.url), "utf8");

  assert.match(menu, /<div v-if="hasDialogHeader\(\)" class="header-area"><slot name="dialog-header" \/><\/div>/u);
  assert.match(editor, /:items="visibleConversationItems"/u);
  assert.match(editor, /<template #dialog-header>\s*<AppTabs\s+v-if="conversationTabs\.length > 0"/u);
  assert.match(editor, /channel: platform,/u);
  // A tab is its channel's logo alone, and the tabs share the row equally.
  assert.match(editor, /:modelValue="conversationTab"\s+iconOnly\s+equal\s/u);
  assert.match(tabs, /'is-equal': equal/u);
  assert.match(tabStyles, /\.app-tabs\.is-equal \.app-tabs-option\.is-icon-only\s*\{\s*flex: 1 1 0;\s*width: auto;/u);
  // The list keeps one height across tabs, so choosing a tab does not move the dialog.
  assert.match(editor, /:scrollHeight="conversationListHeight"/u);
});
