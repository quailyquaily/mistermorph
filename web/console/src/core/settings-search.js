import {
  AUTOMATION_CONFIG_GROUPS,
  CHANNEL_CONFIG_GROUPS,
  CHANNEL_TRIGGER_CONFIG_GROUPS,
  CONSOLE_DEPLOYMENT_CONFIG_GROUPS,
  DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS,
  LLM_CONTEXT_CONFIG_GROUPS,
  LLM_SYSTEM_CONFIG_GROUPS,
  REMOTE_CONTROL_CONFIG_GROUPS,
  SECURITY_CONFIG_GROUPS,
  SYSTEM_ADVANCED_CONFIG_GROUPS,
  SYSTEM_CONFIG_GROUPS,
  TOOL_ADVANCED_CONFIG_GROUPS,
} from "./config-field-groups";

const MAX_RESULTS = 40;

// Settings written by hand in SettingsView (not from config-field-groups), by i18n key. A key
// names both the label and how the field is found on the page: the row whose label reads it.
const HAND_WRITTEN_FIELDS = {
  persona: [
    "settings_persona_avatar_title",
    "settings_persona_identity_name_label",
    "settings_persona_identity_emoji_label",
    "settings_persona_identity_creature_label",
    "settings_persona_identity_vibe_label",
    "settings_persona_soul_title",
  ],
  agent: [
    "settings_agent_provider_label",
    "settings_agent_endpoint_label",
    "settings_agent_model_label",
    "settings_llm_reasoning_label",
    "settings_agent_profiles_title",
    "settings_agent_fallback_title",
  ],
  security: [
    "settings_console_guard_enabled_title",
    "settings_console_guard_allowed_url_prefixes_label",
    "settings_console_guard_deny_private_ips_title",
    "settings_console_guard_follow_redirects_title",
    "settings_console_guard_allow_proxy_title",
    "settings_console_guard_redaction_title",
    "settings_console_guard_approvals_title",
  ],
  system: [
    "settings_language_title",
    "settings_logs_title",
    "settings_session_title",
    "settings_auto_update_card_title",
    "settings_update_channel_title",
    "settings_update_auto_title",
    "settings_update_version_title",
  ],
  console: ["remote_agents_title"],
};

// Each channel pane's own fields, by i18n key.
const CHANNEL_FIELDS = {
  telegram: ["settings_console_telegram_bot_token_label", "settings_console_telegram_allowed_chat_ids_label", "settings_console_group_trigger_label"],
  slack: [
    "settings_console_slack_bot_token_label",
    "settings_console_slack_app_token_label",
    "settings_console_slack_allowed_team_ids_label",
    "settings_console_slack_allowed_channel_ids_label",
    "settings_console_group_trigger_label",
  ],
  line: [
    "settings_console_line_channel_access_token_label",
    "settings_console_line_channel_secret_label",
    "settings_console_line_allowed_group_ids_label",
    "settings_console_group_trigger_label",
  ],
  lark: [
    "settings_console_lark_app_id_label",
    "settings_console_lark_app_secret_label",
    "settings_console_lark_allowed_chat_ids_label",
    "settings_console_group_trigger_label",
  ],
  mixin: ["settings_console_mixin_keystore_file_label", "settings_console_mixin_allowed_conversation_ids_label"],
  discord: [
    "settings_console_discord_bot_token_label",
    "settings_console_discord_allowed_guild_ids_label",
    "settings_console_discord_allowed_channel_ids_label",
    "settings_console_discord_allowed_user_ids_label",
    "settings_console_group_trigger_label",
  ],
  wechat: ["settings_console_wechat_account_label"],
  whatsapp: ["settings_console_whatsapp_api_token_label"],
  bluesky: ["settings_console_bluesky_identifier_label", "settings_console_bluesky_app_password_label", "settings_console_bluesky_service_url_label"],
  x: ["settings_console_x_client_id_label", "settings_console_x_client_secret_label", "settings_console_x_account_label"],
};

function fieldEntries(groups, where, target) {
  const out = [];
  for (const group of groups) {
    const groupWhere = group.title ? [...where, group.title] : where;
    for (const field of group.fields || []) {
      out.push({
        title: field.label,
        path: field.path,
        note: field.note || "",
        where: groupWhere,
        target: { ...target, path: field.path },
      });
    }
  }
  return out;
}

// buildSettingsSearchIndex lists every setting Settings can show for this endpoint: sections,
// config fields (with their config path), hand-written fields, channels and tools. Each entry's
// target says where it lives: the section, and the channel pane or Advanced dialog that holds it.
export function buildSettingsSearchIndex(t, { sections = [], channels = [], tools = [] } = {}) {
  const sectionTitles = new Map(sections.map((item) => [item.id, item.title]));
  const has = (id) => sectionTitles.has(id);
  const advanced = t("settings_advanced_action");
  const entries = [];

  for (const section of sections) {
    entries.push({ title: section.title, note: section.meta || "", where: [], target: { section: section.id }, isSection: true });
  }
  for (const [section, keys] of Object.entries(HAND_WRITTEN_FIELDS)) {
    if (!has(section)) continue;
    for (const key of keys) {
      entries.push({ title: t(key), where: [sectionTitles.get(section)], target: { section, text: t(key) } });
    }
  }

  if (has("agent")) {
    const where = [sectionTitles.get("agent")];
    const defaultModel = t("settings_agent_default_profile_label");
    entries.push(...fieldEntries(LLM_SYSTEM_CONFIG_GROUPS, where, { section: "agent" }));
    entries.push(...fieldEntries(DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS.map((group) => ({ ...group, title: "" })), [...where, defaultModel, advanced], {
      section: "agent",
      dialog: "llm-advanced",
    }));
    entries.push(...fieldEntries(LLM_CONTEXT_CONFIG_GROUPS, where, { section: "agent", dialog: "llm-context" }));
  }
  if (has("tools")) {
    const where = [sectionTitles.get("tools")];
    for (const tool of tools) {
      const title = t(tool.titleKey);
      entries.push({ title, note: t(tool.noteKey), where, target: { section: "tools", text: title } });
      const groups = TOOL_ADVANCED_CONFIG_GROUPS[tool.id];
      if (groups) {
        entries.push(...fieldEntries(groups.map((group) => ({ ...group, title: "" })), [...where, title, advanced], {
          section: "tools",
          dialog: `tool:${tool.id}`,
        }));
      }
    }
  }
  if (has("channels")) {
    const where = [sectionTitles.get("channels")];
    for (const channel of channels) {
      const name = t(channel.titleKey);
      const channelWhere = [...where, name];
      entries.push({ title: name, where, target: { section: "channels", channel: channel.id } });
      for (const key of CHANNEL_FIELDS[channel.id] || []) {
        entries.push({ title: t(key), where: channelWhere, target: { section: "channels", channel: channel.id, text: t(key) } });
      }
      const trigger = CHANNEL_TRIGGER_CONFIG_GROUPS.find((group) => group.id === channel.id);
      if (trigger) {
        entries.push(...fieldEntries([{ ...trigger, title: "" }], channelWhere, { section: "channels", channel: channel.id }));
      }
      const behavior = CHANNEL_CONFIG_GROUPS.find((group) => group.id === channel.id);
      if (behavior) {
        entries.push(...fieldEntries([{ ...behavior, title: "" }], [...channelWhere, advanced], {
          section: "channels",
          channel: channel.id,
          dialog: `channel:${channel.id}`,
        }));
      }
    }
  }
  if (has("security")) {
    entries.push(...fieldEntries(SECURITY_CONFIG_GROUPS, [sectionTitles.get("security")], { section: "security" }));
  }
  if (has("automation")) {
    entries.push(...fieldEntries(AUTOMATION_CONFIG_GROUPS, [sectionTitles.get("automation")], { section: "automation" }));
  }
  if (has("system")) {
    const where = [sectionTitles.get("system")];
    entries.push(...fieldEntries(SYSTEM_CONFIG_GROUPS, where, { section: "system" }));
    entries.push(...fieldEntries(SYSTEM_ADVANCED_CONFIG_GROUPS, [...where, advanced], { section: "system" }));
  }
  if (has("console")) {
    const where = [sectionTitles.get("console")];
    entries.push(...fieldEntries(REMOTE_CONTROL_CONFIG_GROUPS, where, { section: "console" }));
    entries.push(...fieldEntries(CONSOLE_DEPLOYMENT_CONFIG_GROUPS, [...where, t("remote_advanced_title")], { section: "console" }));
  }

  return entries.map((entry, index) => ({
    ...entry,
    id: `s${index}`,
    haystack: [entry.title, entry.path, entry.note, ...entry.where].filter(Boolean).join("\n").toLowerCase(),
  }));
}

// searchSettings returns the entries holding every word of query, best first: a title that starts
// with the query, then one containing it, then a config path containing it, then the rest.
export function searchSettings(index, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const words = needle.split(/\s+/);
  const rank = (entry) => {
    const title = String(entry.title || "").toLowerCase();
    if (title.startsWith(needle)) return 0;
    if (title.includes(needle)) return 1;
    if (String(entry.path || "").toLowerCase().includes(needle)) return 2;
    return 3;
  };
  return index
    .filter((entry) => words.every((word) => entry.haystack.includes(word)))
    .map((entry, order) => ({ entry, order, rank: rank(entry) + (entry.isSection ? -0.5 : 0) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_RESULTS)
    .map((item) => item.entry);
}
