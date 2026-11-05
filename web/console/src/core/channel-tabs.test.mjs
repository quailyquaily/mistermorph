import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALL_CHANNELS_TAB_ID,
  activeChannelTab,
  channelTabs,
  channelTitle,
  itemsForChannelTab,
} from "./channel-tabs.js";

const items = [
  { id: "a", channel: "slack" },
  { id: "b", channel: "Telegram" },
  { id: "c", channel: "telegram" },
  { id: "d", channel: "matrix" },
  { id: "e" },
];

test("channelTabs lists All and then each channel that has an item, in a fixed order", () => {
  const tabs = channelTabs(items, { allTitle: "Everything", icon: (channel) => `icon-${channel}` });
  assert.deepEqual(tabs, [
    { id: ALL_CHANNELS_TAB_ID, title: "Everything" },
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

test("itemsForChannelTab keeps every item under All and one channel's items under its tab", () => {
  assert.equal(itemsForChannelTab(items, ALL_CHANNELS_TAB_ID).length, 5);
  assert.equal(itemsForChannelTab(items, "").length, 5);
  assert.deepEqual(itemsForChannelTab(items, "telegram").map((item) => item.id), ["b", "c"]);
  assert.deepEqual(itemsForChannelTab(items, "line"), []);
  assert.deepEqual(itemsForChannelTab(null, "telegram"), []);
});

test("activeChannelTab falls back to All when the chosen channel has gone", () => {
  const tabs = channelTabs(items);
  assert.equal(activeChannelTab(tabs, "slack").id, "slack");
  assert.equal(activeChannelTab(tabs, "line").id, ALL_CHANNELS_TAB_ID);
  assert.equal(activeChannelTab(tabs, "").id, ALL_CHANNELS_TAB_ID);
  assert.equal(activeChannelTab([], "slack"), null);
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

  assert.match(menu, /<div v-if="hasDialogHeader\(\)" class="header-area"><slot name="dialog-header" \/><\/div>/u);
  assert.match(editor, /:items="visibleConversationItems"/u);
  assert.match(editor, /<template #dialog-header>\s*<AppTabs\s+v-if="conversationTabs\.length > 0"/u);
  assert.match(editor, /channel: platform,/u);
  // The list keeps one height across tabs, so choosing a tab does not move the dialog.
  assert.match(editor, /:scrollHeight="conversationListHeight"/u);
});

test("tabs with iconOnly \"auto\" drop their labels only while one of them is cut", async () => {
  const tabs = await readFile(new URL("../components/AppTabs.js", import.meta.url), "utf8");

  assert.match(tabs, /iconOnly: \{ type: \[Boolean, String\], default: false \}/u);
  assert.match(tabs, /props\.iconOnly === "auto" \? labelsCut\.value : Boolean\(props\.iconOnly\)/u);
  assert.match(tabs, /labelsCut\.value = labels\.some\(\(label\) => label\.scrollWidth > label\.clientWidth \+ 0\.5\)/u);
  assert.match(tabs, /new ResizeObserver\(\(\) => \{\s*fitLabels\(\);/u);
});
