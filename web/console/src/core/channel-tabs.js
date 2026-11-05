// Tabs that split a picker's items by channel: "All" first, then one tab per channel that has an
// item, in a fixed order so a tab keeps its place from one agent to the next. With fewer than
// two channels there is nothing to split, and no tabs.
//
//   const tabs = channelTabs(items, { allTitle: t("…_all"), icon });
//   const shown = itemsForChannelTab(items, activeChannelTab(tabs, chosenID)?.id);
//
// An item's channel is its `channel` field ("telegram", "slack", …).

export const ALL_CHANNELS_TAB_ID = "all";

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
export function channelTabs(items, { allTitle = "All", icon = () => null } = {}) {
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
  const ordered = [...channels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    { id: ALL_CHANNELS_TAB_ID, title: allTitle },
    ...ordered.map((channel) => ({ id: channel, title: channelTitle(channel), icon: icon(channel) || undefined })),
  ];
}

// The chosen tab while it still exists, else "All": a channel's tab goes when its last item does.
export function activeChannelTab(tabs, id) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs.find((tab) => tab.id === id) || tabs[0];
}

export function itemsForChannelTab(items, tabID) {
  const list = Array.isArray(items) ? items : [];
  if (!tabID || tabID === ALL_CHANNELS_TAB_ID) return list;
  return list.filter((item) => channelOf(item) === tabID);
}
