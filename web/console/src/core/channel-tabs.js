// Tabs that split a picker's items by channel: one tab per channel that has an item, in a fixed
// order so a tab keeps its place from one agent to the next. With fewer than two channels there
// is nothing to split, and no tabs: every item shows.
//
//   const tabs = channelTabs(items, { icon });
//   const shown = itemsForChannelTab(items, activeChannelTab(tabs, chosenID)?.id);
//
// An item's channel is its `channel` field ("telegram", "slack", …).

const CHANNEL_TITLES = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  lark: "Lark",
  line: "LINE",
  mixin: "Mixin",
  wechat: "WeChat",
  whatsapp: "WhatsApp",
  bluesky: "Bluesky",
  x: "X",
};
const CHANNEL_ORDER = Object.keys(CHANNEL_TITLES);

function channelOf(item) {
  return String(item?.channel || "").trim().toLowerCase();
}

export function channelTitle(channel) {
  const key = String(channel || "").trim().toLowerCase();
  return CHANNEL_TITLES[key] || (key ? key[0].toUpperCase() + key.slice(1) : "");
}

// icon(channel) returns the tab's icon component, or nothing for a tab with a label only.
export function channelTabs(items, { icon = () => null } = {}) {
  const channels = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const channel = channelOf(item);
    if (channel) channels.add(channel);
  }
  if (channels.size < 2) return [];
  const rank = (channel) => {
    const index = CHANNEL_ORDER.indexOf(channel);
    return index < 0 ? CHANNEL_ORDER.length : index;
  };
  return [...channels]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((channel) => ({ id: channel, title: channelTitle(channel), icon: icon(channel) || undefined }));
}

// The chosen tab while it still exists, else the first: a channel's tab goes when its last item
// does. Null when there are no tabs.
export function activeChannelTab(tabs, id) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs.find((tab) => tab.id === id) || tabs[0];
}

// One channel's items, or every item when there is no tab to choose.
export function itemsForChannelTab(items, tabID) {
  const list = Array.isArray(items) ? items : [];
  return tabID ? list.filter((item) => channelOf(item) === tabID) : list;
}

// The most items any one tab shows: what a list must hold to keep one height across the tabs.
export function longestChannelTab(items, tabs) {
  const list = Array.isArray(items) ? items : [];
  if (!Array.isArray(tabs) || tabs.length === 0) return list.length;
  return Math.max(...tabs.map((tab) => itemsForChannelTab(list, tab.id).length));
}
