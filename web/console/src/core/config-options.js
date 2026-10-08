export const IMAGE_PARTS_OPTIONS = [
  { title: "Auto", value: "" },
  { title: "Supported", value: "true" },
  { title: "Not supported", value: "false" },
];

export const CACHE_TTL_OPTIONS = [
  { title: "Default", value: "" },
  { title: "Off", value: "off" },
  { title: "Short (5 minutes)", value: "short" },
  { title: "Long (1 hour)", value: "long" },
];

export const HEARTBEAT_INTERVAL_OPTIONS = [
  { title: "Every 5 minutes", value: "5m" },
  { title: "Every 15 minutes", value: "15m" },
  { title: "Every 30 minutes", value: "30m" },
  { title: "Every hour", value: "1h" },
  { title: "Every 2 hours", value: "2h" },
  { title: "Every 6 hours", value: "6h" },
  { title: "Every 12 hours", value: "12h" },
  { title: "Every 24 hours", value: "24h" },
];

export const HTTP_METHOD_OPTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// Profile abilities (llm.abilities, llm.profiles.<name>.abilities). None selected means all.
export const PROFILE_ABILITY_OPTIONS = ["text", "image", "decision"];

export const TASK_TARGET_OPTIONS = ["console", "telegram", "slack", "line", "lark", "mixin", "discord", "wechat", "whatsapp"];

// Empty choices name what the empty value does.
export const LOGGING_LEVEL_OPTIONS = [
  { title: "Debug", value: "debug" },
  { title: "Info (default)", value: "" },
  { title: "Warn", value: "warn" },
  { title: "Error", value: "error" },
];

export const REASONING_EFFORT_OPTIONS = [
  { title: "Provider default", value: "" },
  { title: "None", value: "none" },
  { title: "Minimal", value: "minimal" },
  { title: "Low", value: "low" },
  { title: "Medium", value: "medium" },
  { title: "High", value: "high" },
  { title: "Max", value: "max" },
  { title: "Extra high", value: "xhigh" },
];

export const AWS_REGION_OPTIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-south-1",
].map((region) => ({ title: region, value: region }));
AWS_REGION_OPTIONS.unshift({ title: "Not set", value: "" });

// Admin identity prefixes accepted by internal/agentpair.ParseAdmins.
export const ADMIN_PLATFORM_OPTIONS = [
  { title: "Telegram", value: "tg", placeholder: "@username or chat ID" },
  { title: "Slack", value: "slack", placeholder: "T123:U234" },
  { title: "LINE", value: "line_user", placeholder: "User ID" },
  { title: "Lark", value: "lark_user", placeholder: "User ID" },
  { title: "Mixin", value: "mixin", placeholder: "User UUID" },
  { title: "Discord", value: "discord_user", placeholder: "User ID" },
];
