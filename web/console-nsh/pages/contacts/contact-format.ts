// How the Contacts page names and describes a contact: its title, channel handles and logos, its
// kind and status, and relative times. Ported from web/console/src/views/ContactsView.js.
import type { ImageAsset } from "nsh";
import blueskyLogo from "../../assets/images/channels/bluesky.svg";
import discordLogo from "../../assets/images/channels/discord.svg";
import larkLogo from "../../assets/images/channels/lark.svg";
import lineLogo from "../../assets/images/channels/line.svg";
import mixinLogo from "../../assets/images/channels/mixin.svg";
import slackLogo from "../../assets/images/channels/slack.svg";
import telegramLogo from "../../assets/images/channels/telegram.svg";
import wechatLogo from "../../assets/images/channels/wechat.svg";
import whatsappLogo from "../../assets/images/channels/whatsapp.svg";
import xLogo from "../../assets/images/channels/x.svg";
import { t } from "../../components/knowledge/parts";
import { currentLocale, formatTime } from "../../lib/core/context.js";

export type Contact = Record<string, any> & { contact_id?: string };

const CHANNEL_LOGOS: Record<string, ImageAsset> = {
  discord: discordLogo,
  wechat: wechatLogo,
  whatsapp: whatsappLogo,
  bluesky: blueskyLogo,
  x: xLogo,
  lark: larkLogo,
  line: lineLogo,
  mixin: mixinLogo,
  slack: slackLogo,
  telegram: telegramLogo,
};

export function normalizeStatus(raw: unknown) {
  return String(raw || "").trim().toLowerCase() === "inactive" ? "inactive" : "active";
}

export function normalizeKind(raw: unknown) {
  return String(raw || "").trim().toLowerCase() === "agent" ? "agent" : "human";
}

export function shortenIdentifier(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-7)}`;
}

function fallbackHandleFromContactID(item: Contact | null, channel: string) {
  const contactID = String(item?.contact_id || "").trim();
  if (!contactID) return "";
  const parts = contactID
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return "";
  const prefix = parts[0].toLowerCase();
  const last = parts[parts.length - 1];
  switch (channel) {
    case "telegram":
      return prefix === "tg" || prefix === "telegram" ? last : "";
    case "slack":
      return prefix === "slack" ? last : "";
    case "line":
      return prefix === "line" ? last : "";
    case "lark":
      return prefix === "lark" || prefix === "lark_user" ? last : "";
    case "mixin":
      return prefix === "mixin" ? last : "";
    case "discord":
      return prefix === "discord_user" ? last : "";
    case "wechat":
      return prefix === "wechat_user" ? last : "";
    case "whatsapp":
      return prefix === "whatsapp_user" ? last : "";
    case "bluesky":
      return prefix === "bluesky_user" ? last : "";
    case "x":
      return prefix === "x_user" ? last : "";
    default:
      return "";
  }
}

export function channelLabel(raw: unknown) {
  const channel = String(raw || "").trim().toLowerCase();
  switch (channel) {
    case "telegram":
    case "tg":
      return t("endpoint_channel_telegram");
    case "slack":
      return t("endpoint_channel_slack");
    case "line":
      return t("endpoint_channel_line");
    case "lark":
      return t("endpoint_channel_lark");
    case "mixin":
      return t("endpoint_channel_mixin");
    case "discord":
      return t("endpoint_channel_discord");
    case "wechat":
      return t("endpoint_channel_wechat");
    case "whatsapp":
      return t("endpoint_channel_whatsapp");
    case "bluesky":
      return t("endpoint_channel_bluesky");
    case "x":
      return t("endpoint_channel_x");
    case "console":
      return t("endpoint_channel_console");
    default:
      return String(raw || "").trim() || "—";
  }
}

export interface Handle {
  key: string;
  channelKey: string;
  channel: string;
  full: string;
  short: string;
}

export function channelHandles(item: Contact | null): Handle[] {
  const out: Handle[] = [];
  const seen = new Set<string>();
  function push(channel: string, raw: unknown) {
    const full = String(raw || "").trim();
    if (!full) return;
    const key = `${channel}:${full}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, channelKey: channel, channel: channelLabel(channel), full, short: shortenIdentifier(full) });
  }
  const str = (value: unknown) => String(value || "").trim();
  const telegramUsername = str(item?.tg_username).replace(/^@+/, "");
  push("telegram", telegramUsername ? `@${telegramUsername}` : fallbackHandleFromContactID(item, "telegram"));
  push("slack", str(item?.slack_user_id) || fallbackHandleFromContactID(item, "slack"));
  push("line", str(item?.line_user_id) || fallbackHandleFromContactID(item, "line"));
  push("lark", str(item?.lark_open_id) || fallbackHandleFromContactID(item, "lark"));
  const mixinIdentity = str(item?.mixin_identity_number);
  push("mixin", mixinIdentity ? `@${mixinIdentity}` : str(item?.mixin_user_id) || fallbackHandleFromContactID(item, "mixin"));
  push("discord", str(item?.discord_user_id) || fallbackHandleFromContactID(item, "discord"));
  push("wechat", str(item?.wechat_user_id) || fallbackHandleFromContactID(item, "wechat"));
  push("whatsapp", str(item?.whatsapp_user_id) || fallbackHandleFromContactID(item, "whatsapp"));
  push("bluesky", str(item?.bluesky_user_id) || fallbackHandleFromContactID(item, "bluesky"));
  push("x", str(item?.x_user_id) || fallbackHandleFromContactID(item, "x"));
  return out;
}

export function channelLogo(raw: unknown): ImageAsset | null {
  const channel = String(raw || "").trim().toLowerCase();
  return CHANNEL_LOGOS[channel === "tg" ? "telegram" : channel] || null;
}

export function relativeTime(value: unknown) {
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = (timestamp - Date.now()) / 1000;
  const absoluteSeconds = Math.abs(seconds);
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let divisor = 1;
  if (absoluteSeconds >= 365 * 86400) {
    unit = "year";
    divisor = 365 * 86400;
  } else if (absoluteSeconds >= 30 * 86400) {
    unit = "month";
    divisor = 30 * 86400;
  } else if (absoluteSeconds >= 7 * 86400) {
    unit = "week";
    divisor = 7 * 86400;
  } else if (absoluteSeconds >= 86400) {
    unit = "day";
    divisor = 86400;
  } else if (absoluteSeconds >= 3600) {
    unit = "hour";
    divisor = 3600;
  } else if (absoluteSeconds >= 60) {
    unit = "minute";
    divisor = 60;
  }
  try {
    return new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
  } catch {
    return formatTime(value);
  }
}

function namedTitle(item: Contact | null) {
  const nickname = String(item?.nickname || "").trim();
  if (nickname) return nickname;
  const telegramUsername = String(item?.tg_username || "").trim().replace(/^@+/, "");
  return telegramUsername ? `@${telegramUsername}` : "";
}

// Without a name, the channel identifier tells contacts apart; "Unnamed" moves to the meta line.
export function displayName(item: Contact | null) {
  return namedTitle(item) || channelHandles(item)[0]?.short || shortenIdentifier(item?.contact_id) || t("contacts_unnamed");
}

export const isAgent = (item: Contact | null) => normalizeKind(item?.kind) === "agent";
export const isActive = (item: Contact | null) => normalizeStatus(item?.status) === "active";
export const statusText = (item: Contact | null) => (isActive(item) ? t("contacts_status_active") : t("contacts_status_inactive"));
export const kindText = (item: Contact | null) => (isAgent(item) ? t("contacts_kind_agent") : t("contacts_kind_human"));

export function primaryContactMeta(item: Contact | null) {
  if (!namedTitle(item)) return `${channelLabel(item?.channel)} · ${t("contacts_unnamed")}`;
  const handle = channelHandles(item)[0];
  if (handle) return `${handle.channel} · ${handle.short}`;
  const channel = channelLabel(item?.channel);
  const contactID = shortenIdentifier(item?.contact_id);
  return contactID ? `${channel} · ${contactID}` : channel;
}

/**
 * The handle a library card shows under its channel's logo: the first handle's short form, the
 * contact's id when it has none, or "Unnamed User" for a contact without a name (whose title is then
 * its handle already).
 */
export function cardHandle(item: Contact | null) {
  if (!namedTitle(item)) return t("contacts_unnamed");
  return channelHandles(item)[0]?.short || shortenIdentifier(item?.contact_id) || "";
}

export function matchesFilter(item: Contact, query: string) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [
    displayName(item),
    String(item?.contact_id || "").trim(),
    channelLabel(item?.channel),
    kindText(item),
    statusText(item),
    ...channelHandles(item).map((handle) => `${handle.channel} ${handle.full}`),
  ]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

export const contactAccessibilityLabel = (item: Contact) => `${displayName(item)}, ${kindText(item)}, ${statusText(item)}`;
