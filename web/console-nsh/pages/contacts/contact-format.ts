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

export type ContactKind = "human" | "agent";

/** A contact's kind: `agent`, else (any other value, or none) `human`. */
export function normalizeKind(raw: unknown): ContactKind {
  return String(raw || "").trim().toLowerCase() === "agent" ? "agent" : "human";
}

/** The contacts of one kind (the Contacts page's tabs), in the order given. */
export function contactsOfKind<T extends Contact>(items: readonly T[], kind: ContactKind): T[] {
  return items.filter((item) => normalizeKind(item?.kind) === kind);
}

// An RFC 3339 time as the API writes them (Go's time.Time: `2026-11-14T09:30:00.123456789+09:00`).
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

// Go's zero time, which the API may write for "never".
const GO_ZERO_TIME = (() => {
  const zero = new Date(0);
  zero.setUTCFullYear(1, 0, 1);
  zero.setUTCHours(0, 0, 0, 0);
  return zero.getTime();
})();

/**
 * When the agent last interacted with the contact, in milliseconds since the epoch (with the
 * sub-millisecond digits as a fraction), from its recorded `last_interaction_at` only; `null` when it
 * has none, or one that is not a valid RFC 3339 time (a day or hour out of range included), or Go's
 * zero time (`0001-01-01T00:00:00Z`, "never", as the backend reads it). Parsed by hand, not with
 * `Date.parse`, so every runtime reads the same strings the same way. No other time stands in for it.
 */
export function lastInteractionTime(item: Contact | null | undefined): number | null {
  const raw = item?.last_interaction_at;
  if (typeof raw !== "string") return null;
  const match = RFC3339.exec(raw.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetMinutes = 0;
  if (!match[8]) {
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (match[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const fraction = match[7] ? Number(`0.${match[7]}`) * 1000 : 0;
  const time = date.getTime() - offsetMinutes * 60_000 + fraction;
  return time === GO_ZERO_TIME ? null : time;
}

const contactKey = (item: Contact | null | undefined) => String(item?.contact_id || "").trim();

/**
 * The contacts by their last interaction, the most recent first; those with none recorded (or an
 * invalid one) after all the others. Equal times, and those with none, go by contact id (a plain
 * string comparison, not the locale's, so the same on every runtime and in every language), then as
 * they came. A new array: `items` stays as it is.
 */
export function sortByLastInteraction<T extends Contact>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, time: lastInteractionTime(item), key: contactKey(item) }))
    .sort((a, b) => {
      if (a.time !== b.time) {
        if (a.time === null) return 1;
        if (b.time === null) return -1;
        return b.time - a.time;
      }
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
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
