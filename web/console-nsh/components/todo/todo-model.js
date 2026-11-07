// The TODO page's model, from web/console/src/views/TodoView.js nearly verbatim: how a TODO item is
// normalized, edited, validated, serialized and described. Editing functions mutate the task they
// are given, as the Vue view did; the page applies them to a copy (cloneTaskForDraft) and stores it.
import { currentLocale, translate } from "../../lib/core/context.js";
import { isValidCronExpression } from "../../lib/core/cron.js";
import channelDiscordLogoURL from "../../assets/images/channels/discord.svg";
import channelWeChatLogoURL from "../../assets/images/channels/wechat.svg";
import channelWhatsAppLogoURL from "../../assets/images/channels/whatsapp.svg";
import channelBlueskyLogoURL from "../../assets/images/channels/bluesky.svg";
import channelXLogoURL from "../../assets/images/channels/x.svg";
import channelLarkLogoURL from "../../assets/images/channels/lark.svg";
import channelLineLogoURL from "../../assets/images/channels/line.svg";
import channelSlackLogoURL from "../../assets/images/channels/slack.svg";
import channelTelegramLogoURL from "../../assets/images/channels/telegram.svg";

const t = translate;

// What an editing function did: whether the task changed, and whether the inputs showing a
// normalized value must show it again (the Vue view's repeatInputRevision).
const EDIT_CHANGED = { changed: true, refresh: false };
const EDIT_CHANGED_REFRESH = { changed: true, refresh: true };
const EDIT_REFRESH_ONLY = { changed: false, refresh: true };
const EDIT_NONE = { changed: false, refresh: false };

const REPEAT_KINDS = [
  { id: "hourly", labelKey: "todo_repeat_hourly" },
  { id: "daily", labelKey: "todo_repeat_daily" },
  { id: "weekly", labelKey: "todo_repeat_weekly" },
  { id: "monthly", labelKey: "todo_repeat_monthly" },
  { id: "custom", labelKey: "todo_repeat_custom" },
];

const WEEKDAYS = [
  { value: 0, labelKey: "todo_weekday_sun" },
  { value: 1, labelKey: "todo_weekday_mon" },
  { value: 2, labelKey: "todo_weekday_tue" },
  { value: 3, labelKey: "todo_weekday_wed" },
  { value: 4, labelKey: "todo_weekday_thu" },
  { value: 5, labelKey: "todo_weekday_fri" },
  { value: 6, labelKey: "todo_weekday_sat" },
];

const DEFAULT_CRON = "0 9 * * *";
const DEFAULT_REPEAT_TIME = "09:00";
const DEFAULT_REPEAT_KIND = "daily";
const DEFAULT_TODO_TITLE = "";
const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";
const HEARTBEAT_ITEM_KEY = "__heartbeat__";
const CONSOLE_NOTIFICATION_CHAT_ID = "console:user";
const CONSOLE_NOTIFICATION_ICON = "PhDesktop";
const CHAT_PLATFORM_LOGOS = {
  discord: channelDiscordLogoURL,
  wechat: channelWeChatLogoURL,
  whatsapp: channelWhatsAppLogoURL,
  bluesky: channelBlueskyLogoURL,
  x: channelXLogoURL,
  lark: channelLarkLogoURL,
  line: channelLineLogoURL,
  slack: channelSlackLogoURL,
  telegram: channelTelegramLogoURL,
};
const CONTACT_REF_PROTOCOLS = new Set(["tg", "slack", "line", "line_user", "lark", "lark_user", "discord", "discord_user", "wechat", "wechat_user", "whatsapp", "whatsapp_user", "bluesky", "bluesky_user", "x", "x_user"]);
const UTC_TIMEZONE_ITEMS = [
  { value: "UTC-12", label: "UTC-12", cityKey: "todo_timezone_city_baker_island" },
  { value: "UTC-11", label: "UTC-11", cityKey: "todo_timezone_city_pago_pago" },
  { value: "UTC-10", label: "UTC-10", cityKey: "todo_timezone_city_honolulu" },
  { value: "UTC-9", label: "UTC-9", cityKey: "todo_timezone_city_anchorage" },
  { value: "UTC-8", label: "UTC-8", cityKey: "todo_timezone_city_los_angeles" },
  { value: "UTC-7", label: "UTC-7", cityKey: "todo_timezone_city_denver" },
  { value: "UTC-6", label: "UTC-6", cityKey: "todo_timezone_city_mexico_city" },
  { value: "UTC-5", label: "UTC-5", cityKey: "todo_timezone_city_new_york" },
  { value: "UTC-4", label: "UTC-4", cityKey: "todo_timezone_city_santiago" },
  { value: "UTC-3", label: "UTC-3", cityKey: "todo_timezone_city_buenos_aires" },
  { value: "UTC-2", label: "UTC-2", cityKey: "todo_timezone_city_south_georgia" },
  { value: "UTC-1", label: "UTC-1", cityKey: "todo_timezone_city_azores" },
  { value: "UTC", label: "UTC+0", cityKey: "todo_timezone_city_london" },
  { value: "UTC+1", label: "UTC+1", cityKey: "todo_timezone_city_paris" },
  { value: "UTC+2", label: "UTC+2", cityKey: "todo_timezone_city_cairo" },
  { value: "UTC+3", label: "UTC+3", cityKey: "todo_timezone_city_moscow" },
  { value: "UTC+4", label: "UTC+4", cityKey: "todo_timezone_city_dubai" },
  { value: "UTC+5", label: "UTC+5", cityKey: "todo_timezone_city_karachi" },
  { value: "UTC+6", label: "UTC+6", cityKey: "todo_timezone_city_dhaka" },
  { value: "UTC+7", label: "UTC+7", cityKey: "todo_timezone_city_bangkok" },
  { value: "UTC+8", label: "UTC+8", cityKey: "todo_timezone_city_shanghai" },
  { value: "UTC+9", label: "UTC+9", cityKey: "todo_timezone_city_tokyo" },
  { value: "UTC+10", label: "UTC+10", cityKey: "todo_timezone_city_sydney" },
  { value: "UTC+11", label: "UTC+11", cityKey: "todo_timezone_city_noumea" },
  { value: "UTC+12", label: "UTC+12", cityKey: "todo_timezone_city_auckland" },
  { value: "UTC+13", label: "UTC+13", cityKey: "todo_timezone_city_apia" },
  { value: "UTC+14", label: "UTC+14", cityKey: "todo_timezone_city_kiritimati" },
];

let taskKeySeed = 0;

function nextTaskKey() {
  taskKeySeed += 1;
  return `todo-task-${Date.now()}-${taskKeySeed}`;
}

function trimText(value) {
  return String(value || "").trim();
}

// What a TODO item's topic lookup is for: the agent and the item.
function taskTopicKey(endpointRef, taskID) {
  const ref = trimText(endpointRef);
  const id = trimText(taskID);
  return ref && id ? `${ref}\u0000${id}` : "";
}

function browserTimezone() {
  try {
    return trimText(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "";
  }
}

function timezoneOffsetMinutes(timezone) {
  const value = trimText(timezone);
  if (!value) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: value,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const raw = trimText(parts.find((part) => part.type === "timeZoneName")?.value);
    if (raw === "GMT" || raw === "UTC") {
      return 0;
    }
    const match = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) {
      return null;
    }
    const sign = match[1] === "-" ? -1 : 1;
    const hour = Number(match[2]);
    const minute = Number(match[3] || "0");
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      return null;
    }
    return sign * (hour * 60 + minute);
  } catch {
    return null;
  }
}

function formatUTCOffsetValue(minutes) {
  if (!Number.isInteger(minutes) || minutes % 60 !== 0) {
    return "UTC";
  }
  if (minutes === 0) {
    return "UTC";
  }
  const prefix = minutes > 0 ? "+" : "-";
  return `UTC${prefix}${Math.abs(minutes / 60)}`;
}

function browserUTCOffsetValue() {
  return formatUTCOffsetValue(timezoneOffsetMinutes(browserTimezone()));
}

function normalizeScheduleMode(value) {
  return trimText(value).toLowerCase() === "recurring" ? "recurring" : "once";
}

function taskMode(task) {
  const explicit = trimText(task?.mode).toLowerCase();
  if (explicit === "once" || explicit === "recurring") {
    return explicit;
  }
  return trimText(task?.cron) !== "" && trimText(task?.at) === "" ? "recurring" : "once";
}

function normalizeRepeatKind(value) {
  const kind = trimText(value).toLowerCase();
  return REPEAT_KINDS.some((item) => item.id === kind) ? kind : DEFAULT_REPEAT_KIND;
}

function normalizeTimeInput(value) {
  const match = trimText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return DEFAULT_REPEAT_TIME;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return DEFAULT_REPEAT_TIME;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

function cronTimeParts(value) {
  const time = normalizeTimeInput(value);
  const [hour, minute] = time.split(":");
  return { hour: String(Number(hour)), minute: String(Number(minute)) };
}

function normalizeMonthDay(value) {
  const text = trimText(value);
  if (!/^\d+$/.test(text)) {
    return "1";
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed)) {
    return "1";
  }
  return String(Math.min(31, Math.max(1, parsed)));
}

function normalizeMinuteInput(value) {
  const text = trimText(value);
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return Math.min(59, Math.max(0, parsed));
}

function normalizeWeekdays(values) {
  const items = Array.isArray(values) ? values : [];
  const seen = new Set();
  for (const item of items) {
    const value = Number(item);
    if (Number.isInteger(value) && value >= 0 && value <= 6) {
      seen.add(value);
    }
  }
  const out = [...seen].sort((left, right) => left - right);
  return out.length > 0 ? out : [1];
}

function parseCronParts(raw) {
  const parts = trimText(raw).split(/\s+/).filter(Boolean);
  return parts.length === 5 ? parts : null;
}

function parseSingleCronNumber(raw, min, max) {
  if (!/^\d+$/.test(trimText(raw))) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function parseCronNumberSet(raw, min, max, sundayAlias = false) {
  const text = trimText(raw);
  if (!text || text === "*") {
    return null;
  }
  const values = new Set();
  for (const token of text.split(",")) {
    const part = trimText(token);
    if (!part) {
      return null;
    }
    if (part.includes("/")) {
      return null;
    }
    if (part.includes("-")) {
      const [startRaw, endRaw, extra] = part.split("-");
      if (extra !== undefined) {
        return null;
      }
      const start = parseSingleCronNumber(startRaw, min, max);
      const end = parseSingleCronNumber(endRaw, min, max);
      if (start === null || end === null || start > end) {
        return null;
      }
      for (let value = start; value <= end; value += 1) {
        values.add(sundayAlias && value === 7 ? 0 : value);
      }
      continue;
    }
    const value = parseSingleCronNumber(part, min, max);
    if (value === null) {
      return null;
    }
    values.add(sundayAlias && value === 7 ? 0 : value);
  }
  return [...values].sort((left, right) => left - right);
}

function inferRecurringState(rawCron) {
  const cron = normalizeCron(rawCron) || DEFAULT_CRON;
  const parts = parseCronParts(cron);
  if (!parts) {
    return {
      repeat_kind: "custom",
      repeat_time: DEFAULT_REPEAT_TIME,
      repeat_weekdays: [1],
      repeat_month_day: "1",
      custom_cron: cron,
    };
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  const minute = parseSingleCronNumber(minuteRaw, 0, 59);
  const hour = parseSingleCronNumber(hourRaw, 0, 23);
  if (minute === null) {
    return {
      repeat_kind: "custom",
      repeat_time: DEFAULT_REPEAT_TIME,
      repeat_weekdays: [1],
      repeat_month_day: "1",
      custom_cron: cron,
    };
  }
  const minuteTime = `00:${pad2(minute)}`;
  if (hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return { repeat_kind: "hourly", repeat_time: minuteTime, repeat_weekdays: [1], repeat_month_day: "1", custom_cron: cron };
  }
  if (hour === null) {
    return {
      repeat_kind: "custom",
      repeat_time: minuteTime,
      repeat_weekdays: [1],
      repeat_month_day: "1",
      custom_cron: cron,
    };
  }
  const time = `${pad2(hour)}:${pad2(minute)}`;
  if (domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return { repeat_kind: "daily", repeat_time: time, repeat_weekdays: [1], repeat_month_day: "1", custom_cron: cron };
  }
  if (domRaw === "*" && monthRaw === "*") {
    const days = parseCronNumberSet(dowRaw, 0, 7, true);
    if (days) {
      return { repeat_kind: "weekly", repeat_time: time, repeat_weekdays: days, repeat_month_day: "1", custom_cron: cron };
    }
  }
  if (monthRaw === "*" && dowRaw === "*") {
    const day = parseSingleCronNumber(domRaw, 1, 31);
    if (day !== null) {
      return { repeat_kind: "monthly", repeat_time: time, repeat_weekdays: [1], repeat_month_day: String(day), custom_cron: cron };
    }
  }
  return {
    repeat_kind: "custom",
    repeat_time: time,
    repeat_weekdays: [1],
    repeat_month_day: "1",
    custom_cron: cron,
  };
}

function recurringCron(task) {
  const kind = normalizeRepeatKind(task?.repeat_kind);
  if (kind === "custom") {
    return normalizeCron(task?.custom_cron ?? task?.cron);
  }
  const { minute, hour } = cronTimeParts(task?.repeat_time);
  switch (kind) {
    case "hourly":
      return `${minute} * * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${normalizeWeekdays(task?.repeat_weekdays).join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${normalizeMonthDay(task?.repeat_month_day)} * *`;
    case "daily":
    default:
      return `${minute} ${hour} * * *`;
  }
}

function normalizeBashEnv(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  const out = [];
  for (const item of refs) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const name = trimText(item.name);
    const value = String(item.value ?? "");
    if (!name && !trimText(value)) {
      continue;
    }
    out.push({ name, value });
  }
  return out;
}

function compactBashEnv(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs
    .map((item) => ({
      name: trimText(item?.name),
      value: String(item?.value ?? ""),
    }))
    .filter((item) => item.name !== "" || trimText(item.value) !== "");
}

function isValidBashEnvName(raw) {
  const key = trimText(raw);
  if (!key) {
    return false;
  }
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (key[i] === "_" || isLetter) {
      continue;
    }
    if (i > 0 && code >= 48 && code <= 57) {
      continue;
    }
    return false;
  }
  return true;
}

function bashEnvValidationMessage(refs, t) {
  const rows = Array.isArray(refs) ? refs : [];
  const seen = new Set();
  for (const item of rows) {
    const name = trimText(item?.name);
    const value = trimText(item?.value);
    if (!name && !value) {
      continue;
    }
    if (!name && value) {
      return t("todo_validation_bash_env_name_required");
    }
    if (!isValidBashEnvName(name)) {
      return t("todo_validation_bash_env_name_invalid", { name });
    }
    if (seen.has(name)) {
      return t("todo_validation_bash_env_duplicate", { name });
    }
    seen.add(name);
  }
  return "";
}

function normalizeTask(item = {}, fallbackTitle = DEFAULT_TODO_TITLE) {
  const at = trimText(item.at);
  const cron = trimText(item.cron);
  const recurring = inferRecurringState(cron);
  return {
    _key: nextTaskKey(),
    id: trimText(item.id),
    title: trimText(item.title) || fallbackTitle,
    enabled: item.enabled !== false,
    at,
    cron,
    tz: trimText(item.tz),
    content: trimText(item.content),
    chat_id: trimText(item.chat_id),
    llm_profile: trimText(item.llm_profile),
    workspace_dir: trimText(item.workspace_dir),
    bash_env: normalizeBashEnv(item.bash_env),
    mode: cron !== "" && at === "" ? "recurring" : "once",
    ...recurring,
  };
}

function normalizeChatOptions(items) {
  const rows = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const item of rows) {
    const chatID = trimText(item?.chat_id);
    const name = trimText(item?.name);
    if (!chatID || !name) {
      continue;
    }
    const key = chatID.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      chat_id: chatID,
      platform: trimText(item?.platform),
      type: trimText(item?.type),
      name,
      expires_at: trimText(item?.expires_at),
    });
  }
  return out.sort((left, right) => {
    const leftTitle = `${left.name} ${left.platform} ${left.type}`.toLowerCase();
    const rightTitle = `${right.name} ${right.platform} ${right.type}`.toLowerCase();
    return leftTitle.localeCompare(rightTitle);
  });
}

function normalizeLLMProfiles(items) {
  const rows = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const item of rows) {
    const name = trimText(typeof item === "string" ? item : item?.name);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      name,
      inferenceProvider: trimText(item?.inference_provider || item?.provider),
      modelName: trimText(item?.model),
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

function chatPlatformFromID(chatID) {
  const protocol = trimText(chatID).split(":", 1)[0].toLowerCase();
  if (protocol === "tg") {
    return "telegram";
  }
  if (protocol === "line_user") {
    return "line";
  }
  if (protocol === "lark_user") {
    return "lark";
  }
  if (protocol === "discord_user") {
    return "discord";
  }
  if (protocol === "wechat_user") {
    return "wechat";
  }
  if (protocol === "whatsapp_user") {
    return "whatsapp";
  }
  if (protocol === "bluesky_user") {
    return "bluesky";
  }
  if (protocol === "x_user") {
    return "x";
  }
  if (["slack", "line", "lark", "discord", "wechat", "whatsapp", "bluesky", "x"].includes(protocol)) {
    return protocol;
  }
  return "";
}

function chatPlatformLogoImage(option) {
  const platform = trimText(option?.platform).toLowerCase() || chatPlatformFromID(option?.chat_id || option?.value);
  return CHAT_PLATFORM_LOGOS[platform] || "";
}

function cloneTaskForDraft(task) {
  if (!task) {
    return null;
  }
  return {
    ...task,
    repeat_weekdays: Array.isArray(task.repeat_weekdays) ? [...task.repeat_weekdays] : [1],
    bash_env: Array.isArray(task.bash_env)
      ? task.bash_env.map((item) => ({
          name: String(item?.name ?? ""),
          value: String(item?.value ?? ""),
        }))
      : [],
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function defaultAtValue() {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())} ${pad2(next.getHours())}:${pad2(next.getMinutes())}`;
}

function normalizeCron(raw) {
  return trimText(raw).split(/\s+/).filter(Boolean).join(" ");
}

function parseEveryCronStep(raw) {
  const match = trimText(raw).match(/^\*\/(\d+)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function positiveCronStep(raw) {
  const text = trimText(raw);
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isValidAtValue(raw) {
  const match = trimText(raw)
    .replace("T", " ")
    .match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) {
    return false;
  }
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function atInputValue(task) {
  return trimText(task?.at).replace(" ", "T");
}

function serializeTask(task, fallbackTitle = DEFAULT_TODO_TITLE) {
  const mode = taskMode(task);
  const out = {
    id: trimText(task?.id),
    title: trimText(task?.title) || fallbackTitle || DEFAULT_TODO_TITLE,
    content: trimText(task?.content),
  };
  if (task?.enabled === false) {
    out.enabled = false;
  }
  if (mode === "recurring") {
    out.cron = normalizeCron(task?.cron);
  } else {
    out.at = trimText(task?.at).replace("T", " ");
  }
  const tz = trimText(task?.tz);
  if (tz) {
    out.tz = tz;
  }
  const chatID = trimText(task?.chat_id);
  if (chatID) {
    out.chat_id = chatID;
  }
  const llmProfile = trimText(task?.llm_profile);
  if (llmProfile) {
    out.llm_profile = llmProfile;
  }
  const workspaceDir = trimText(task?.workspace_dir);
  if (workspaceDir) {
    out.workspace_dir = workspaceDir;
  }
  const bashEnv = compactBashEnv(task?.bash_env);
  if (bashEnv.length > 0) {
    out.bash_env = bashEnv;
  }
  return out;
}

function normalizeTaskBeforeSave(task) {
  if (!task) {
    return;
  }
  if (taskMode(task) !== "recurring") {
    return;
  }
  const kind = normalizeRepeatKind(task.repeat_kind);
  task.repeat_kind = kind;
  if (kind === "hourly") {
    const minute = normalizeMinuteInput(cronTimeParts(task.repeat_time).minute);
    task.repeat_time = `00:${pad2(minute ?? 0)}`;
  }
  if (kind === "monthly") {
    task.repeat_month_day = normalizeMonthDay(task.repeat_month_day);
  }
  task.cron = recurringCron(task);
}

/* ---------- from the view's setup ---------- */

function taskTitle(task) {
  return trimText(task?.title).replace(/\s+/g, " ") || t("todo_untitled");
}

function chatOptionTitle(option) {
  if (trimText(option?.platform).toLowerCase() === "console") {
    return t("todo_chat_console_user");
  }
  const name = trimText(option?.name);
  return name || t("todo_chat_unavailable");
}

function chatOptionSubtitle(option) {
  if (trimText(option?.platform).toLowerCase() === "console") {
    return t("todo_chat_console_notification");
  }
  return displayChatType(option?.type);
}

function displayChatType(value) {
  const type = trimText(value).toLowerCase();
  if (!type) {
    return "";
  }
  const locale = currentLocale();
  const zh = locale === "zh-CN";
  const ja = locale === "ja-JP";
  const labels = {
    private: zh ? "私聊" : ja ? "個人チャット" : "Private chat",
    im: zh ? "私聊" : ja ? "個人チャット" : "Private chat",
    direct: zh ? "私聊" : ja ? "個人チャット" : "Private chat",
    dm: zh ? "私聊" : ja ? "個人チャット" : "Private chat",
    group: zh ? "群聊" : ja ? "グループチャット" : "Group chat",
    supergroup: zh ? "群聊" : ja ? "グループチャット" : "Group chat",
    channel: zh ? "频道" : ja ? "チャンネル" : "Channel",
    room: zh ? "群聊" : ja ? "ルーム" : "Room",
    thread: zh ? "Thread" : ja ? "スレッド" : "Thread",
  };
  return labels[type] || type;
}

function safeMentionLabel(raw) {
  return trimText(raw)
    .replace(/[\[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isContactReferenceID(raw) {
  const value = trimText(raw);
  const protocol = value.split(":", 1)[0].toLowerCase();
  return CONTACT_REF_PROTOCOLS.has(protocol);
}

function contactReferencesFromContent(raw) {
  const text = String(raw || "");
  const refs = [];
  const seen = new Set();
  const re = /\[([^\]\r\n]+)\]\(([^)\s]+)\)/g;
  let match = re.exec(text);
  while (match) {
    const label = safeMentionLabel(match[1]);
    const id = trimText(match[2]);
    const key = id.toLowerCase();
    if (label && id && isContactReferenceID(id) && !seen.has(key)) {
      seen.add(key);
      refs.push({ label, id });
    }
    match = re.exec(text);
  }
  return refs;
}

function updateScheduleMode(task, mode) {
  if (!task) {
    return EDIT_NONE;
  }
  task.mode = normalizeScheduleMode(mode);
  if (task.mode === "recurring") {
    if (!trimText(task.cron)) {
      task.cron = DEFAULT_CRON;
    }
    const recurring = inferRecurringState(task.cron);
    task.repeat_kind = recurring.repeat_kind;
    task.repeat_time = recurring.repeat_time;
    task.repeat_weekdays = recurring.repeat_weekdays;
    task.repeat_month_day = recurring.repeat_month_day;
    task.custom_cron = recurring.custom_cron;
    task.cron = recurringCron(task);
  }
  if (task.mode === "once" && !trimText(task.at)) {
    task.at = defaultAtValue();
  }
}

function updateAtInput(task, value) {
  const text = trimText(value).replace("T", " ");
  const match = text.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?::\d{2})?$/);
  task.at = match ? match[1] : text;
}

function syncRecurringCron(task) {
  if (!task) {
    return EDIT_NONE;
  }
  task.cron = recurringCron(task);
}

function updateRepeatKind(task, kind) {
  if (!task) {
    return EDIT_NONE;
  }
  task.repeat_kind = normalizeRepeatKind(kind);
  if (!trimText(task.repeat_time)) {
    task.repeat_time = DEFAULT_REPEAT_TIME;
  }
  if (!Array.isArray(task.repeat_weekdays) || task.repeat_weekdays.length === 0) {
    task.repeat_weekdays = [1];
  }
  if (!trimText(task.repeat_month_day)) {
    task.repeat_month_day = "1";
  }
  if (!trimText(task.custom_cron)) {
    task.custom_cron = trimText(task.cron) || DEFAULT_CRON;
  }
  syncRecurringCron(task);
}

function updateRepeatTime(task, value) {
  if (!task) {
    return EDIT_NONE;
  }
  task.repeat_time = trimText(value) || DEFAULT_REPEAT_TIME;
  syncRecurringCron(task);
}

function repeatMinuteValue(task) {
  const [, minute] = normalizeTimeInput(task?.repeat_time).split(":");
  return String(Number(minute));
}

function updateRepeatMinute(task, value) {
  if (!task) {
    return EDIT_NONE;
  }
  const raw = trimText(value);
  const minute = normalizeMinuteInput(value);
  if (minute === null) {
    return EDIT_REFRESH_ONLY;
  }
  task.repeat_time = `00:${pad2(minute)}`;
  syncRecurringCron(task);
  return raw !== String(minute) ? EDIT_CHANGED_REFRESH : EDIT_CHANGED;
}

function updateRepeatMonthDay(task, value) {
  if (!task) {
    return EDIT_NONE;
  }
  const raw = trimText(value);
  const day = normalizeMonthDay(value);
  task.repeat_month_day = day;
  syncRecurringCron(task);
  return raw !== day ? EDIT_CHANGED_REFRESH : EDIT_CHANGED;
}

function updateCustomCron(task, value) {
  if (!task) {
    return EDIT_NONE;
  }
  task.custom_cron = String(value || "");
  syncRecurringCron(task);
}

function weekdaySelected(task, weekday) {
  return normalizeWeekdays(task?.repeat_weekdays).includes(Number(weekday));
}

function toggleRepeatWeekday(task, weekday) {
  if (!task) {
    return EDIT_NONE;
  }
  const value = Number(weekday);
  const days = normalizeWeekdays(task.repeat_weekdays);
  if (days.includes(value)) {
    if (days.length === 1) {
      return EDIT_NONE;
    }
    task.repeat_weekdays = days.filter((day) => day !== value);
  } else {
    task.repeat_weekdays = normalizeWeekdays([...days, value]);
  }
  syncRecurringCron(task);
}

function weekdayLabel(value) {
  const item = WEEKDAYS.find((day) => day.value === Number(value));
  return t(item?.labelKey || "todo_weekday_mon");
}

function repeatKind(task) {
  return normalizeRepeatKind(task?.repeat_kind);
}

function cronValidationMessage(raw) {
  return isValidCronExpression(raw) ? "" : t("todo_validation_cron_invalid");
}

function cronPreviewError(task) {
  if (!task || taskMode(task) !== "recurring") {
    return "";
  }
  return cronValidationMessage(recurringCron(task));
}

function schedulePreviewError(task) {
  if (!task) {
    return "";
  }
  if (taskMode(task) === "once") {
    return isValidAtValue(task.at) ? "" : t("todo_validation_at_required");
  }
  return cronPreviewError(task);
}

function markedPreviewValue(value) {
  const text = trimText(value);
  return text ? `[[${text}]]` : "";
}

function previewLanguage() {
  const locale = currentLocale();
  if (locale.startsWith("zh")) {
    return "zh";
  }
  if (locale.startsWith("ja")) {
    return "ja";
  }
  return "en";
}

function parseAtPreviewParts(raw) {
  const match = trimText(raw)
    .replace("T", " ")
    .match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return {
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function previewDateText(parts) {
  if (!parts) {
    return t("todo_schedule_missing");
  }
  switch (previewLanguage()) {
    case "zh":
    case "ja":
      return `${parts.month}${t("todo_preview_month_unit")}${parts.day}${t("todo_preview_day_unit")}`;
    default:
      return new Intl.DateTimeFormat(currentLocale(), {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2000, parts.month - 1, parts.day)));
  }
}

function previewTimeText(hourRaw, minuteRaw) {
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return "";
  }
  switch (previewLanguage()) {
    case "zh":
      return minute === 0 ? `${hour}点` : `${hour}点${minute}分`;
    case "ja":
      return minute === 0 ? `${hour}時` : `${hour}時${minute}分`;
    default: {
      const suffix = hour < 12 ? "AM" : "PM";
      const hour12 = hour % 12 || 12;
      return minute === 0 ? `${hour12} ${suffix}` : `${hour12}:${pad2(minute)} ${suffix}`;
    }
  }
}

function previewTimeFromInput(raw) {
  const [hour, minute] = normalizeTimeInput(raw).split(":");
  return previewTimeText(Number(hour), Number(minute));
}

function previewWeekdayValues(values) {
  return normalizeWeekdays(values).sort((left, right) => {
    const normalizedLeft = left === 0 ? 7 : left;
    const normalizedRight = right === 0 ? 7 : right;
    return normalizedLeft - normalizedRight;
  });
}

function previewWeekdayName(value) {
  const day = Number(value);
  switch (previewLanguage()) {
    case "zh":
      return ["日", "一", "二", "三", "四", "五", "六"][day] || "一";
    case "ja":
      return ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"][day] || "月曜";
    default:
      return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] || "Monday";
  }
}

function joinPreviewList(items) {
  const values = items.map((item) => trimText(item)).filter(Boolean);
  if (values.length <= 1) {
    return values[0] || "";
  }
  const last = values[values.length - 1];
  const head = values.slice(0, -1);
  switch (previewLanguage()) {
    case "zh":
      return `${head.join("、")}和周${last}`;
    case "ja":
      return `${head.join("、")}と${last}`;
    default:
      return values.length === 2 ? `${head[0]} and ${last}` : `${head.join(", ")}, and ${last}`;
  }
}

function previewWeekdayText(values) {
  return joinPreviewList(previewWeekdayValues(values).map((day) => previewWeekdayName(day)));
}

function previewMonthDayList(days) {
  const values = (Array.isArray(days) ? days : []).map((item) => Number(item)).filter((item) => Number.isInteger(item));
  if (values.length <= 1) {
    return values[0] ? String(values[0]) : "";
  }
  switch (previewLanguage()) {
    case "zh":
      return values.join("、");
    case "ja":
      return joinPreviewList(values.map((item) => `${item}日`));
    default:
      return joinPreviewList(values.map((item) => String(item)));
  }
}

function joinGenericPreviewList(items) {
  const values = items.map((item) => trimText(item)).filter(Boolean);
  if (values.length <= 1) {
    return values[0] || "";
  }
  const last = values[values.length - 1];
  const head = values.slice(0, -1);
  switch (previewLanguage()) {
    case "zh":
      return `${head.join("、")}和${last}`;
    case "ja":
      return `${head.join("、")}と${last}`;
    default:
      return values.length === 2 ? `${head[0]} and ${last}` : `${head.join(", ")}, and ${last}`;
  }
}

function previewFullWeekdayName(value) {
  const day = Number(value) === 7 ? 0 : Number(value);
  switch (previewLanguage()) {
    case "zh":
      return `周${["日", "一", "二", "三", "四", "五", "六"][day] || "一"}`;
    case "ja":
      return ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"][day] || "月曜";
    default:
      return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] || "Monday";
  }
}

function previewMonthName(value) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return "";
  }
  switch (previewLanguage()) {
    case "zh":
    case "ja":
      return `${month}${t("todo_preview_month_unit")}`;
    default:
      return new Intl.DateTimeFormat(currentLocale(), {
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2000, month - 1, 1)));
  }
}

function cronFieldValuePreviewText(kind, value) {
  const number = Number(value);
  switch (kind) {
    case "minute":
      switch (previewLanguage()) {
        case "zh":
          return `${number}分`;
        case "ja":
          return `${number}分`;
        default:
          return `minute ${pad2(number)}`;
      }
    case "hour":
      switch (previewLanguage()) {
        case "zh":
          return `${number}点`;
        case "ja":
          return `${number}時`;
        default:
          return `hour ${number}`;
      }
    case "day":
      switch (previewLanguage()) {
        case "zh":
        case "ja":
          return `${number}${t("todo_preview_day_unit")}`;
        default:
          return String(number);
      }
    case "month":
      return previewMonthName(number);
    case "weekday":
      return previewFullWeekdayName(number);
    default:
      return String(number);
  }
}

function cronFieldEveryPreviewText(kind) {
  switch (previewLanguage()) {
    case "zh":
      return {
        minute: "每分钟",
        hour: "每小时",
        day: "每日",
        month: "每月",
        weekday: "每天",
      }[kind];
    case "ja":
      return {
        minute: "毎分",
        hour: "毎時",
        day: "毎日",
        month: "毎月",
        weekday: "毎日",
      }[kind];
    default:
      return {
        minute: "every minute",
        hour: "every hour",
        day: "every day of month",
        month: "every month",
        weekday: "every day of week",
      }[kind];
  }
}

function cronFieldRangePreviewText(kind, start, end) {
  const left = cronFieldValuePreviewText(kind, start);
  const right = cronFieldValuePreviewText(kind, end);
  switch (previewLanguage()) {
    case "zh":
      return `${left}到${right}`;
    case "ja":
      return `${left}から${right}`;
    default:
      return `${left} through ${right}`;
  }
}

function cronStepUnit(kind, count) {
  switch (previewLanguage()) {
    case "zh":
      return {
        minute: "分钟",
        hour: "小时",
        day: "天",
        month: "个月",
        weekday: "天",
      }[kind];
    case "ja":
      return {
        minute: "分",
        hour: "時間",
        day: "日",
        month: "か月",
        weekday: "日",
      }[kind];
    default: {
      const units = {
        minute: "minute",
        hour: "hour",
        day: "day",
        month: "month",
        weekday: "day",
      };
      const unit = units[kind] || "unit";
      return count === 1 ? unit : `${unit}s`;
    }
  }
}

function cronFieldEveryStepPreviewText(kind, count) {
  switch (previewLanguage()) {
    case "zh":
      return `每 ${count} ${cronStepUnit(kind, count)}`;
    case "ja":
      return `${count}${cronStepUnit(kind, count)}ごと`;
    default:
      return `every ${count} ${cronStepUnit(kind, count)}`;
  }
}

function parseCronPreviewToken(raw, min, max) {
  const [baseRaw, stepRaw, extra] = trimText(raw).split("/");
  if (!baseRaw || extra !== undefined) {
    return null;
  }
  const step = stepRaw === undefined ? null : positiveCronStep(stepRaw);
  if (stepRaw !== undefined && step === null) {
    return null;
  }
  if (baseRaw === "*") {
    return { type: "any", step };
  }
  if (baseRaw.includes("-")) {
    const [startRaw, endRaw, rangeExtra] = baseRaw.split("-");
    if (rangeExtra !== undefined) {
      return null;
    }
    const start = parseSingleCronNumber(startRaw, min, max);
    const end = parseSingleCronNumber(endRaw, min, max);
    if (start === null || end === null || start > end) {
      return null;
    }
    return { type: "range", start, end, step };
  }
  const value = parseSingleCronNumber(baseRaw, min, max);
  return value === null ? null : { type: "single", value, step };
}

function cronTokenBasePreviewText(token, kind) {
  if (!token) {
    return "";
  }
  if (token.type === "any") {
    return cronFieldEveryPreviewText(kind);
  }
  if (token.type === "range") {
    return cronFieldRangePreviewText(kind, token.start, token.end);
  }
  return cronFieldValuePreviewText(kind, token.value);
}

function cronTokenPreviewText(token, kind) {
  if (!token) {
    return "";
  }
  if (!token.step) {
    return cronTokenBasePreviewText(token, kind);
  }
  if (token.type === "any") {
    return cronFieldEveryStepPreviewText(kind, token.step);
  }
  const base = cronTokenBasePreviewText(token, kind);
  switch (previewLanguage()) {
    case "zh":
      return `${base}中${cronFieldEveryStepPreviewText(kind, token.step)}`;
    case "ja":
      return `${base}のうち${cronFieldEveryStepPreviewText(kind, token.step)}`;
    default:
      return `${cronFieldEveryStepPreviewText(kind, token.step)} from ${base}`;
  }
}

function cronFieldPreviewText(raw, kind, min, max) {
  const values = trimText(raw)
    .split(",")
    .map((item) => cronTokenPreviewText(parseCronPreviewToken(item, min, max), kind))
    .filter(Boolean);
  return values.length > 0 ? joinGenericPreviewList(values) : trimText(raw);
}

function customCronTimePreviewText(minuteRaw, hourRaw) {
  const minute = parseSingleCronNumber(minuteRaw, 0, 59);
  const hour = parseSingleCronNumber(hourRaw, 0, 23);
  if (minute !== null && hour !== null) {
    const time = previewTimeText(hour, minute);
    return previewLanguage() === "en" ? `At ${time}` : time;
  }
  if (minute !== null && hourRaw === "*") {
    return t("todo_preview_schedule_hourly", { minute: pad2(minute) });
  }
  const minuteText = cronFieldPreviewText(minuteRaw, "minute", 0, 59);
  const hourText = cronFieldPreviewText(hourRaw, "hour", 0, 23);
  switch (previewLanguage()) {
    case "zh":
      return `${hourText}的${minuteText}`;
    case "ja":
      return `${hourText}の${minuteText}`;
    default:
      return `${minuteText} during ${hourText}`;
  }
}

function customCronConstraintText(kind, raw) {
  const ranges = {
    day: [1, 31],
    month: [1, 12],
    weekday: [0, 7],
  };
  const [min, max] = ranges[kind] || [0, 0];
  const value = cronFieldPreviewText(raw, kind, min, max);
  switch (previewLanguage()) {
    case "zh":
      return {
        day: `日期为${value}`,
        month: `月份为${value}`,
        weekday: `星期为${value}`,
      }[kind];
    case "ja":
      return {
        day: `日付が${value}`,
        month: `月が${value}`,
        weekday: `曜日が${value}`,
      }[kind];
    default:
      return {
        day: `day of month is ${value}`,
        month: `month is ${value}`,
        weekday: `weekday is ${value}`,
      }[kind];
  }
}

function customCronGenericSchedulePreview(parts) {
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  const time = customCronTimePreviewText(minuteRaw, hourRaw);
  const constraints = [];
  if (domRaw !== "*") {
    constraints.push(customCronConstraintText("day", domRaw));
  }
  if (monthRaw !== "*") {
    constraints.push(customCronConstraintText("month", monthRaw));
  }
  if (dowRaw !== "*") {
    constraints.push(customCronConstraintText("weekday", dowRaw));
  }
  if (constraints.length === 0) {
    return time;
  }
  const constraintText = joinGenericPreviewList(constraints);
  switch (previewLanguage()) {
    case "zh":
      return `${time}，${constraintText}时`;
    case "ja":
      return `${time}、${constraintText}のとき`;
    default:
      return `${time} when ${constraintText}`;
  }
}

function previewMonthlySchedule(day, time) {
  return t("todo_preview_schedule_monthly", { day, time });
}

function customCronSchedulePreview(task) {
  const cron = recurringCron(task);
  const parts = parseCronParts(cron);
  if (!parts || !isValidCronExpression(cron)) {
    return t("todo_preview_custom_invalid");
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  if (minuteRaw === "*" && hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return t("todo_preview_custom_every_minute");
  }
  const minuteStep = parseEveryCronStep(minuteRaw);
  if (minuteStep !== null && hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return t("todo_preview_custom_every_minutes", { count: minuteStep });
  }
  const minute = parseSingleCronNumber(minuteRaw, 0, 59);
  const hour = parseSingleCronNumber(hourRaw, 0, 23);
  if (minute !== null && hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return t("todo_preview_schedule_hourly", { minute: pad2(minute) });
  }
  if (minute !== null && hour !== null) {
    const time = previewTimeText(hour, minute);
    if (domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
      return t("todo_preview_schedule_daily", { time });
    }
    if (domRaw === "*" && monthRaw === "*") {
      const days = parseCronNumberSet(dowRaw, 0, 7, true);
      if (days) {
        return t("todo_preview_schedule_weekly", { days: previewWeekdayText(days), time });
      }
    }
    if (monthRaw === "*" && dowRaw === "*") {
      const day = parseSingleCronNumber(domRaw, 1, 31);
      if (day !== null) {
        return previewMonthlySchedule(day, time);
      }
      const days = parseCronNumberSet(domRaw, 1, 31, false);
      if (days) {
        return t("todo_preview_schedule_month_days", { days: previewMonthDayList(days), time });
      }
    }
  }
  return customCronGenericSchedulePreview(parts);
}

function naturalSchedulePreview(task) {
  if (taskMode(task) === "once") {
    const parts = parseAtPreviewParts(task?.at);
    return t("todo_preview_schedule_once", {
      date: previewDateText(parts),
      time: parts ? previewTimeText(parts.hour, parts.minute) : "",
    });
  }
  const kind = repeatKind(task);
  if (kind === "custom") {
    return customCronSchedulePreview(task);
  }
  const time = previewTimeFromInput(task?.repeat_time);
  switch (kind) {
    case "hourly": {
      const [, minute] = normalizeTimeInput(task?.repeat_time).split(":");
      return t("todo_preview_schedule_hourly", { minute });
    }
    case "weekly":
      return t("todo_preview_schedule_weekly", { days: previewWeekdayText(task?.repeat_weekdays), time });
    case "monthly":
      return previewMonthlySchedule(normalizeMonthDay(task?.repeat_month_day), time);
    case "daily":
    default:
      return t("todo_preview_schedule_daily", { time });
  }
}

function schedulePreviewText(task) {
  return schedulePreviewError(task) || naturalSchedulePreview(task);
}

function previewPeopleText(task) {
  const refs = contactReferencesFromContent(task?.content);
  if (refs.length === 0) {
    return "";
  }
  return refs.map((item) => item.label).filter(Boolean).join(t("todo_preview_people_separator"));
}

function previewSentence(task) {
  const title = markedPreviewValue(taskTitle(task));
  const error = schedulePreviewError(task);
  if (error) {
    return t("todo_preview_error_summary", {
      title,
      error: markedPreviewValue(error),
    });
  }
  const people = previewPeopleText(task);
  return t(people ? "todo_preview_natural_with_people" : "todo_preview_natural", {
    schedule: markedPreviewValue(schedulePreviewText(task)),
    title,
    people: markedPreviewValue(people),
  });
}

function previewSegments(task) {
  const source = previewSentence(task);
  const parts = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let offset = 0;
  let match = re.exec(source);
  while (match) {
    if (match.index > offset) {
      parts.push({ type: "text", text: source.slice(offset, match.index) });
    }
    if (match[1]) {
      parts.push({ type: "mark", text: match[1] });
    }
    offset = match.index + match[0].length;
    match = re.exec(source);
  }
  if (offset < source.length) {
    parts.push({ type: "text", text: source.slice(offset) });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: source }];
}

function taskValidationMessage(task) {
  if (!task) {
    return "";
  }
  if (!trimText(task.content)) {
    return t("todo_validation_content_required");
  }
  if (taskMode(task) === "once") {
    if (!isValidAtValue(task.at)) {
      return t("todo_validation_at_required");
    }
  } else {
    const cronMessage = cronValidationMessage(recurringCron(task));
    if (cronMessage) {
      return cronMessage;
    }
  }
  return bashEnvValidationMessage(task.bash_env, t);
}

function ensureBashEnv(task) {
  if (!task) {
    return [];
  }
  if (!Array.isArray(task.bash_env)) {
    task.bash_env = [];
  }
  return task.bash_env;
}

function hasBashEnvRows(task) {
  return Array.isArray(task?.bash_env) && task.bash_env.length > 0;
}

function addBashEnvRow(task) {
  if (!task) {
    return EDIT_NONE;
  }
  ensureBashEnv(task).push({ name: "", value: "" });
}

function removeBashEnvRow(task, index) {
  if (!task) {
    return EDIT_NONE;
  }
  const rows = ensureBashEnv(task);
  if (index < 0 || index >= rows.length) {
    return EDIT_NONE;
  }
  rows.splice(index, 1);
}

function updateBashEnvField(task, index, field, value) {
  if (!task || (field !== "name" && field !== "value")) {
    return EDIT_NONE;
  }
  const rows = ensureBashEnv(task);
  if (index < 0 || index >= rows.length) {
    return EDIT_NONE;
  }
  rows[index][field] = String(value ?? "");
}

function visibleTaskValidationMessage(task) {
  const message = taskValidationMessage(task);
  return message === t("todo_validation_content_required") ? "" : message;
}


/* ---------- the page's menus, from the view's computed values ---------- */

function updateTaskField(task, field, value) {
  if (!task || !field) {
    return EDIT_NONE;
  }
  task[field] = String(value || "");
}

function updateTaskEnabled(task, value) {
  if (!task) {
    return EDIT_NONE;
  }
  task.enabled = value !== false;
}

function timezoneBaseItems() {
  return UTC_TIMEZONE_ITEMS.map((item) => ({
    id: `tz-${item.value}`,
    title: `${item.label} · ${t(item.cityKey)}`,
    value: item.value,
  }));
}

function timezoneItem(task) {
  const items = timezoneBaseItems();
  const current = trimText(task?.tz) || browserUTCOffsetValue();
  return (
    items.find((item) => item.value === current) ||
    (trimText(task?.tz) ? { id: `tz-current-${current}`, title: current, value: current } : null) ||
    items.find((item) => item.value === "UTC") ||
    items[0]
  );
}

function scheduleModeItems() {
  return [
    { id: "schedule-once", title: t("todo_mode_once"), value: "once" },
    { id: "schedule-recurring", title: t("todo_mode_recurring"), value: "recurring" },
  ];
}

function repeatKindTabs() {
  return REPEAT_KINDS.map((kind) => ({ id: kind.id, title: t(kind.labelKey) }));
}

function chatMenuItems(chatOptions) {
  return [
    { id: "chat-none", title: t("todo_chat_none"), value: "", icon: "PhProhibit" },
    ...(Array.isArray(chatOptions) ? chatOptions : []).map((item) => ({
      id: `chat-${item.chat_id}`,
      title: chatOptionTitle(item),
      subtitle: chatOptionSubtitle(item),
      value: item.chat_id,
      image: chatPlatformLogoImage(item),
      icon: item.chat_id === CONSOLE_NOTIFICATION_CHAT_ID ? CONSOLE_NOTIFICATION_ICON : undefined,
    })),
  ];
}

function chatItem(items, task) {
  const chatID = trimText(task?.chat_id);
  if (!chatID) {
    return items[0];
  }
  return (
    items.find((item) => item.value === chatID) || {
      id: `chat-current-${chatID}`,
      title: t("todo_chat_unavailable"),
      value: chatID,
      image: chatPlatformLogoImage({ chat_id: chatID }),
      icon: chatID === CONSOLE_NOTIFICATION_CHAT_ID ? CONSOLE_NOTIFICATION_ICON : undefined,
    }
  );
}

function llmProfileMenuItems(defaultRouteModel, profiles, vendorMeta) {
  const defaultVendor = vendorMeta(defaultRouteModel);
  return [
    {
      id: "llm-profile-none",
      title: t("todo_llm_profile_none"),
      subtitle: defaultRouteModel,
      value: "",
      image: defaultVendor.icon || undefined,
      icon: defaultVendor.icon ? undefined : "PhCpu",
    },
    ...(Array.isArray(profiles) ? profiles : []).map((profile) => {
      const vendor = vendorMeta(profile.modelName);
      return {
        id: `llm-profile-${profile.name}`,
        title: profile.name,
        subtitle: profile.modelName,
        value: profile.name,
        image: vendor.icon || undefined,
        icon: vendor.icon ? undefined : "PhCpu",
      };
    }),
  ];
}

function llmProfileItem(items, task) {
  const profile = trimText(task?.llm_profile);
  if (!profile) {
    return items[0];
  }
  return (
    items.find((item) => item.value === profile) || {
      id: `llm-profile-unavailable-${profile}`,
      title: t("todo_llm_profile_unavailable", { profile }),
      value: profile,
      icon: "PhCpu",
    }
  );
}

export {
  EDIT_CHANGED,
  EDIT_NONE,
  REPEAT_KINDS,
  WEEKDAYS,
  DEFAULT_REPEAT_KIND,
  HEARTBEAT_FILE_NAME,
  HEARTBEAT_ITEM_KEY,
  CONSOLE_NOTIFICATION_CHAT_ID,
  nextTaskKey,
  trimText,
  pad2,
  taskTopicKey,
  browserUTCOffsetValue,
  taskMode,
  normalizeTask,
  normalizeChatOptions,
  normalizeLLMProfiles,
  cloneTaskForDraft,
  defaultAtValue,
  atInputValue,
  serializeTask,
  normalizeTaskBeforeSave,
  recurringCron,
  taskTitle,
  updateTaskField,
  updateTaskEnabled,
  updateScheduleMode,
  updateAtInput,
  updateRepeatKind,
  updateRepeatTime,
  repeatMinuteValue,
  updateRepeatMinute,
  updateRepeatMonthDay,
  updateCustomCron,
  weekdaySelected,
  toggleRepeatWeekday,
  weekdayLabel,
  repeatKind,
  schedulePreviewError,
  schedulePreviewText,
  previewSegments,
  taskValidationMessage,
  visibleTaskValidationMessage,
  hasBashEnvRows,
  addBashEnvRow,
  removeBashEnvRow,
  updateBashEnvField,
  timezoneBaseItems,
  timezoneItem,
  scheduleModeItems,
  repeatKindTabs,
  chatMenuItems,
  chatItem,
  llmProfileMenuItems,
  llmProfileItem,
};
