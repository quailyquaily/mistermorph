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

// Whether a field's value points at a key kept elsewhere: ${secret:...}, ${ENV} or ${aws-sm:...}.
export function isSecretReference(value) {
  return /^\$\{[^{}\s]+\}$/.test(String(value || "").trim());
}

// What to save for a field config.yaml points at a variable or AWS secret: a key picked for it
// (a reference) over the reference it has.
export function pickedReference(configRef, value) {
  return isSecretReference(value) ? String(value).trim() : configRef;
}

// The variable a ${NAME} reference names; "" for anything else.
export function referenceEnvName(value) {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(value || "").trim());
  return match ? match[1] : "";
}

// Whether the field at path may point at another key instead of its reference (GET /secrets/keys
// fields): only while another field still uses that reference, so its last use is not dropped.
// envName is the variable the field shows ("NAME" or "NAME=value"); one config.yaml does not name
// is set by the environment itself, which config.yaml cannot change.
export function canSwapReference(fields, path, envName = "") {
  const entry = fields && path ? fields[path] : null;
  if (!entry || entry.kind === "file" || entry.shared !== true) {
    return false;
  }
  const variable = String(envName || "").split("=")[0].trim();
  return variable === "" || entry.env_name === variable;
}
