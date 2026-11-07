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

