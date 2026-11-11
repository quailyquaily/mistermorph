// The Settings page's fixed lists (SettingsView.js): sections, tools, channels and what each
// channel runtime adds.
import type { ImageAsset } from "nsh";
import type { IconName } from "../../components/icons";
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

export const CHANNEL_LOGOS: Record<string, ImageAsset> = {
  telegram: telegramLogo,
  slack: slackLogo,
  lark: larkLogo,
  discord: discordLogo,
  mixin: mixinLogo,
  wechat: wechatLogo,
  whatsapp: whatsappLogo,
  bluesky: blueskyLogo,
  x: xLogo,
  line: lineLogo,
};

export interface ToolItem {
  id: string;
  icon: IconName;
  titleKey: string;
  noteKey: string;
  toggle?: boolean;
  automatic?: boolean;
}

export const TOOL_ITEMS: ToolItem[] = [
  { id: "read_file", icon: "PhFileText", titleKey: "settings_tool_read_file", noteKey: "settings_tool_note_read_file", toggle: false },
  { id: "write_file", icon: "PhPencilSimpleLine", titleKey: "settings_tool_write_file", noteKey: "settings_tool_note_write_file" },
  { id: "spawn", icon: "PhGitFork", titleKey: "settings_tool_spawn", noteKey: "settings_tool_note_spawn" },
  { id: "coder", icon: "PhCodeBlock", titleKey: "settings_tool_coder", noteKey: "settings_tool_note_coder" },
  { id: "contacts_send", icon: "PhPaperPlaneTilt", titleKey: "settings_tool_contacts_send", noteKey: "settings_tool_note_contacts_send" },
  { id: "agent_send", icon: "PhRobot", titleKey: "settings_tool_agent_send", noteKey: "settings_tool_note_agent_send", automatic: true },
  { id: "todo_update", icon: "PhCalendarCheck", titleKey: "settings_tool_todo_update", noteKey: "settings_tool_note_todo_update" },
  { id: "plan_create", icon: "PhListChecks", titleKey: "settings_tool_plan_create", noteKey: "settings_tool_note_plan_create" },
  { id: "codemode", icon: "PhCode", titleKey: "settings_tool_codemode", noteKey: "settings_tool_note_codemode" },
  { id: "tool_search", icon: "PhBinoculars", titleKey: "settings_tool_tool_search", noteKey: "settings_tool_note_tool_search" },
  { id: "url_fetch", icon: "PhLink", titleKey: "settings_tool_url_fetch", noteKey: "settings_tool_note_url_fetch" },
  { id: "web_search", icon: "PhMagnifyingGlass", titleKey: "settings_tool_web_search", noteKey: "settings_tool_note_web_search" },
  { id: "bash", icon: "PhTerminalWindow", titleKey: "settings_tool_bash", noteKey: "settings_tool_note_bash" },
  { id: "powershell", icon: "PhTerminalWindow", titleKey: "settings_tool_powershell", noteKey: "settings_tool_note_powershell" },
  { id: "image_generate", icon: "PhMagicWand", titleKey: "settings_tool_image_generate", noteKey: "settings_tool_note_image_generate" },
  { id: "image_edit", icon: "PhPaintBrush", titleKey: "settings_tool_image_edit", noteKey: "settings_tool_note_image_edit" },
];

// The Tools page lists tools in these groups, in this order.
export const TOOL_GROUPS = [
  { id: "files", titleKey: "settings_tool_group_files", items: ["read_file", "write_file", "bash", "powershell"] },
  { id: "web", titleKey: "settings_tool_group_web", items: ["url_fetch", "web_search"] },
  { id: "workflow", titleKey: "settings_tool_group_workflow", items: ["plan_create", "todo_update", "codemode", "tool_search"] },
  { id: "delegation", titleKey: "settings_tool_group_delegation", items: ["spawn", "coder"] },
  { id: "messaging", titleKey: "settings_tool_group_messaging", items: ["contacts_send", "agent_send"] },
  { id: "images", titleKey: "settings_tool_group_images", items: ["image_generate", "image_edit"] },
].map((group) => ({
  ...group,
  tools: group.items.map((id) => TOOL_ITEMS.find((item) => item.id === id)).filter(Boolean) as ToolItem[],
}));

export interface ToolChannel {
  id: string;
  title: string;
  icon?: IconName;
  logo?: ImageAsset;
  tools: string[];
}

// Tools a channel runtime adds in its own chats. They have no setting: each follows its channel.
export const TOOL_CHANNELS: ToolChannel[] = [
  { id: "console", title: "Console", icon: "PhAppWindow", tools: ["message_react", "skill_install_preview", "skill_install"] },
  { id: "telegram", title: "Telegram", logo: telegramLogo, tools: ["send_file", "send_photo", "send_voice", "message_react"] },
  { id: "slack", title: "Slack", logo: slackLogo, tools: ["send_file", "message_react"] },
  { id: "lark", title: "Lark", logo: larkLogo, tools: ["send_file", "send_photo", "send_voice", "message_react"] },
  { id: "discord", title: "Discord", logo: discordLogo, tools: ["send_file", "message_react"] },
  { id: "mixin", title: "Mixin", logo: mixinLogo, tools: ["send_file", "send_photo", "send_voice"] },
  { id: "wechat", title: "WeChat", logo: wechatLogo, tools: ["send_file"] },
  { id: "whatsapp", title: "WhatsApp", logo: whatsappLogo, tools: ["send_file"] },
];

// Rows of the channel tool matrix: the tools channel runtimes add, by name.
export const TOOL_CHANNEL_ROWS: { id: string; icon: IconName }[] = [
  { id: "send_file", icon: "PhPaperclip" },
  { id: "send_photo", icon: "PhImage" },
  { id: "send_voice", icon: "PhMicrophone" },
  { id: "message_react", icon: "PhSmiley" },
  { id: "skill_install_preview", icon: "PhEye" },
  { id: "skill_install", icon: "PhDownloadSimple" },
];

export const MANAGED_RUNTIME_ITEMS = [
  { id: "telegram", titleKey: "settings_console_runtime_telegram", noteKey: "settings_console_runtime_note_telegram" },
  { id: "slack", titleKey: "settings_console_runtime_slack", noteKey: "settings_console_runtime_note_slack" },
  { id: "lark", titleKey: "settings_console_runtime_lark", noteKey: "settings_console_runtime_note_lark" },
  { id: "mixin", titleKey: "settings_console_runtime_mixin", noteKey: "settings_console_runtime_note_mixin" },
  { id: "discord", titleKey: "settings_console_runtime_discord", noteKey: "settings_console_runtime_note_discord" },
  { id: "wechat", titleKey: "settings_console_runtime_wechat", noteKey: "settings_console_runtime_note_wechat" },
  { id: "whatsapp", titleKey: "settings_console_runtime_whatsapp", noteKey: "settings_console_runtime_note_whatsapp" },
  { id: "bluesky", titleKey: "settings_console_runtime_bluesky", noteKey: "settings_console_runtime_note_bluesky" },
  { id: "x", titleKey: "settings_console_runtime_x", noteKey: "settings_console_runtime_note_x" },
];

// The channels on the Channels page. A channel counts as configured when every credential it needs
// is set, in config or by an environment variable.
export const CHANNEL_ITEMS = [
  { id: "telegram", titleKey: "settings_console_telegram_title", required: ["bot_token"] },
  { id: "slack", titleKey: "settings_console_slack_title", required: ["bot_token", "app_token"] },
  { id: "discord", titleKey: "settings_console_discord_title", required: ["bot_token"] },
  { id: "wechat", titleKey: "settings_console_wechat_title", required: ["bot_token"] },
  { id: "whatsapp", titleKey: "settings_console_whatsapp_title", required: ["api_token"] },
  { id: "bluesky", titleKey: "settings_console_bluesky_title", required: ["identifier", "app_password"] },
  { id: "x", titleKey: "settings_console_x_title", required: ["client_id", "login"] },
  { id: "lark", titleKey: "settings_console_lark_title", required: ["app_id", "app_secret"] },
  { id: "line", titleKey: "settings_console_line_title", required: ["channel_access_token", "channel_secret"] },
  { id: "mixin", titleKey: "settings_console_mixin_title", required: ["keystore_file"] },
];

export const CHANNEL_GROUP_TRIGGER_VALUES = ["smart", "strict", "talkative"];
export const LOCAL_CONSOLE_ENDPOINT_REF = "ep_console_local";
export const SETTINGS_DEFAULT_SECTION_ID = "persona";
export const SETTINGS_SECTION_IDS = new Set([
  "agent",
  "routes",
  "tools",
  "mcp",
  "persona",
  "channels",
  "automation",
  "system",
  "runtimes",
  "security",
  "console",
  "app",
  "shortcuts",
  "runtime",
  "credits",
]);
export const UPDATE_RELEASES_URL = "https://mistermorph.com/releases/";

export interface SettingsSection {
  id: string;
  icon: IconName;
  title: string;
  meta?: string;
  saveKind: string;
}
