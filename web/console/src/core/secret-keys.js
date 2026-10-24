// The secret picker's view of the keys in config.yaml (GET /secrets/keys): who uses each key, in
// words, and which keys to offer a field first.

const CHANNEL_NAMES = {
  telegram: "Telegram",
  slack: "Slack",
  line: "LINE",
  lark: "Lark",
  discord: "Discord",
  wechat: "WeChat",
  whatsapp: "WhatsApp",
  bluesky: "Bluesky",
  x: "X",
};

// An LLM secret's place under llm (or llm.profiles.<name>) -> its form field.
const LLM_SECRET_FIELDS = {
  api_key: "api_key",
  "cloudflare.api_token": "cloudflare_api_token",
  "bedrock.aws_key": "bedrock_aws_key",
  "bedrock.aws_secret": "bedrock_aws_secret",
  "bedrock.aws_session_token": "bedrock_aws_session_token",
};

function translated(t, key, fallback) {
  const text = t(key);
  return text && text !== key ? text : fallback;
}

// A secret field's config path in words: "Main model", "Profile ears", "Profile ears · AWS
// Secret", "Telegram Bot Token". t is the console's translate.
export function secretFieldLabel(path, t) {
  const parts = String(path || "").split(".");
  if (parts[0] === "llm") {
    const inProfile = parts[1] === "profiles" && parts.length >= 4;
    const owner = inProfile ? t("secret_picker_profile", { name: parts[2] }) : t("secret_picker_main_model");
    const field = LLM_SECRET_FIELDS[parts.slice(inProfile ? 3 : 1).join(".")];
    if (!field || field === "api_key") {
      return owner;
    }
    return `${owner} · ${translated(t, `settings_agent_${field}_label`, field)}`;
  }
  const channel = CHANNEL_NAMES[parts[0]];
  if (channel && parts.length === 2) {
    return `${channel} ${translated(t, `settings_console_${parts[0]}_${parts[1]}_label`, parts[1])}`;
  }
  return String(path || "");
}

function leaf(path) {
  const parts = String(path || "").split(".");
  return parts[parts.length - 1];
}

// The keys to offer the field at currentPath: not the key it already has, and keys used by the same
// kind of field (another api_key for an api_key) before the rest. The list keeps its order (newest
// first) otherwise.
export function pickerKeys(keys, currentPath = "") {
  const list = Array.isArray(keys) ? keys : [];
  const current = String(currentPath || "");
  const wanted = leaf(current);
  const offered = list.filter((key) => !current || !(key?.used_by || []).includes(current));
  const sameKind = (key) => (key?.used_by || []).some((path) => leaf(path) === wanted);
  return [...offered.filter(sameKind), ...offered.filter((key) => !sameKind(key))];
}
