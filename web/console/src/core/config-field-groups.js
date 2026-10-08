import {
  ADMIN_PLATFORM_OPTIONS,
  AWS_REGION_OPTIONS,
  CACHE_TTL_OPTIONS,
  HEARTBEAT_INTERVAL_OPTIONS,
  IMAGE_PARTS_OPTIONS,
  LOGGING_LEVEL_OPTIONS,
  PROFILE_ABILITY_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  TASK_TARGET_OPTIONS,
} from "./config-options";

export const DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS = [
  {
    id: "model-behavior",
    title: "Default model",
    note: "Low-frequency request and provider settings for the default profile.",
    fields: [
      {
        path: "llm.abilities",
        label: "Abilities",
        type: "string_list",
        options: PROFILE_ABILITY_OPTIONS,
        wide: true,
        note: "None selected means all. Only profiles with text can run subtasks.",
      },
      { path: "llm.context_window_tokens", label: "Context window", type: "int" },
      { path: "llm.supports_image_parts", label: "Supports image parts", type: "select", options: IMAGE_PARTS_OPTIONS },
      { path: "llm.headers", label: "HTTP headers", type: "json", wide: true, editor: "rows", rows: "map", addLabel: "Add header" },
      { path: "llm.cache_ttl", label: "Cache TTL", type: "select", options: CACHE_TTL_OPTIONS, allowCustom: true },
      { path: "llm.cache_key_prefix", label: "Cache key prefix", type: "string" },
      { path: "llm.request_timeout", label: "Request timeout", type: "string", duration: true, editor: "duration" },
      {
        path: "llm.temperature",
        label: "Temperature",
        type: "float",
        clearable: true,
        placeholder: "Provider default",
        note: "Usually 0 to 2. Clear it to use the provider default.",
      },
      { path: "llm.reasoning_effort", label: "Reasoning effort", type: "select", options: REASONING_EFFORT_OPTIONS },
      { path: "llm.reasoning_budget_tokens", label: "Reasoning budget tokens", type: "int" },
      {
        path: "llm.tools_emulation_mode",
        label: "Tools emulation",
        type: "select",
        options: ["off", "fallback", "force"],
      },
      { path: "llm.azure.deployment", label: "Azure deployment", type: "string" },
      { path: "llm.bedrock.aws_session_token", label: "Bedrock session token", type: "string", secret: true },
      { path: "llm.bedrock.aws_profile", label: "Bedrock AWS profile", type: "string" },
    ],
  },
];

export const LLM_SYSTEM_CONFIG_GROUPS = [
  {
    id: "image-model",
    title: "Image generation",
    note: "Settings for image_generate and image_edit. Which model makes the images is the Image route in Model Routes.",
    fields: [
      { path: "llm.image.request_timeout", label: "Request timeout", type: "string", duration: true, editor: "duration" },
      { path: "llm.image.options.openai", label: "OpenAI options", type: "json", wide: true },
      { path: "llm.image.options.gemini", label: "Gemini options", type: "json", wide: true },
      { path: "llm.image.options.cloudflare", label: "Cloudflare options", type: "json", wide: true },
    ],
  },
  {
    id: "execution-limits",
    title: "Execution limits",
    fields: [
      { path: "max_steps", label: "Maximum steps", type: "int" },
      { path: "parse_retries", label: "Parse retries", type: "int" },
      { path: "max_token_budget", label: "Maximum token budget", type: "int", editor: "limit", defaultLimit: "200000" },
      { path: "tool_repeat_limit", label: "Tool repeat limit", type: "int" },
      { path: "timeout", label: "Run timeout", type: "string", duration: true, editor: "duration" },
    ],
  },
];

export const LLM_CONTEXT_CONFIG_GROUPS = [{
  id: "context",
  title: "Context compaction",
  fields: [
    { path: "context_compaction.enabled", label: "Context compaction", type: "bool" },
    {
      path: "context_compaction.trigger_ratio",
      label: "Compact at",
      type: "float",
      editor: "percent",
      dependsOn: "context_compaction.enabled",
      note: "Share of the context window used before older turns are compacted.",
    },
  ],
}];

export const TOOL_ADVANCED_CONFIG_GROUPS = {
  read_file: [{
    id: "read-file",
    title: "read_file",
    fields: [
      { path: "tools.read_file.max_bytes", label: "Read file maximum size", type: "int", editor: "bytes" },
      { path: "tools.read_file.deny_paths", label: "Read file denied paths", type: "string_list", wide: true, editor: "rows", placeholder: "~/.ssh", addLabel: "Add path" },
    ],
  }],
  write_file: [{
    id: "write-file",
    title: "write_file",
    fields: [
      { path: "tools.write_file.max_bytes", label: "Write file maximum size", type: "int", editor: "bytes" },
    ],
  }],
  coder: [{
    id: "coder",
    title: "coder",
    fields: [
      { path: "tools.coder.path_extra", label: "Coder PATH additions", type: "string_list", wide: true, editor: "rows", placeholder: "/opt/tools/bin", addLabel: "Add directory" },
    ],
  }],
  plan_create: [{
    id: "plan-create",
    title: "plan_create",
    fields: [
      { path: "tools.plan_create.max_steps", label: "Plan maximum steps", type: "int" },
    ],
  }],
  codemode: [{
    id: "codemode",
    title: "codemode",
    fields: [
      { path: "tools.codemode.timeout", label: "Script timeout", type: "string", duration: true, editor: "duration" },
      { path: "tools.codemode.max_tool_calls", label: "Maximum tool calls per script", type: "int" },
      { path: "tools.codemode.max_parallel_calls", label: "Maximum parallel calls", type: "int" },
    ],
  }],
  url_fetch: [{
    id: "url-fetch",
    title: "url_fetch",
    fields: [
      { path: "tools.url_fetch.timeout", label: "URL fetch timeout", type: "string", duration: true, editor: "duration" },
      { path: "tools.url_fetch.max_bytes", label: "URL fetch maximum size", type: "int", editor: "bytes" },
      { path: "tools.url_fetch.max_bytes_download", label: "Download maximum size", type: "int", editor: "bytes" },
    ],
  }],
  web_search: [{
    id: "web-search",
    title: "web_search",
    fields: [
      { path: "tools.web_search.base_url", label: "Web search base URL", type: "string", wide: true },
      { path: "tools.web_search.timeout", label: "Web search timeout", type: "string", duration: true, editor: "duration" },
      { path: "tools.web_search.max_results", label: "Web search maximum results", type: "int" },
    ],
  }],
  bash: [{
    id: "bash",
    title: "bash",
    fields: [
      { path: "tools.bash.timeout", label: "Bash timeout", type: "string", duration: true, editor: "duration" },
      { path: "tools.bash.max_output_bytes", label: "Bash maximum output size", type: "int", editor: "bytes" },
      { path: "tools.bash.deny_paths", label: "Bash denied paths", type: "string_list", wide: true, editor: "rows", placeholder: "~/.ssh", addLabel: "Add path" },
      { path: "tools.bash.path_extra", label: "Bash PATH additions", type: "string_list", wide: true, editor: "rows", placeholder: "/opt/tools/bin", addLabel: "Add directory" },
      { path: "tools.bash.injected_env_vars", label: "Bash injected environment", type: "json", wide: true, editor: "rows", rows: "env", addLabel: "Add variable" },
      { path: "tools.bash.rewrite.enabled", label: "Bash command rewrite", type: "bool" },
      { path: "tools.bash.rewrite.binary", label: "Rewrite binary", type: "string", placeholder: "rtk", dependsOn: "tools.bash.rewrite.enabled" },
    ],
  }],
  powershell: [{
    id: "powershell",
    title: "powershell",
    fields: [
      { path: "tools.powershell.timeout", label: "PowerShell timeout", type: "string", duration: true, editor: "duration" },
      { path: "tools.powershell.max_output_bytes", label: "PowerShell maximum output size", type: "int", editor: "bytes" },
      { path: "tools.powershell.deny_paths", label: "PowerShell denied paths", type: "string_list", wide: true, editor: "rows", placeholder: "C:\\Users\\me\\.ssh", addLabel: "Add path" },
      { path: "tools.powershell.injected_env_vars", label: "PowerShell injected environment", type: "json", wide: true, editor: "rows", rows: "env", addLabel: "Add variable" },
    ],
  }],
};

function channelFields(channel, options = {}) {
  const title = options.title || channel[0].toUpperCase() + channel.slice(1);
  const fields = [];
  if (options.baseURL) fields.push({ path: `${channel}.base_url`, label: "API base", type: "string", wide: true });
  if (options.webhook) {
    fields.push(
      { path: `${channel}.webhook_listen`, label: "Webhook listen address", type: "string", validate: "listen", placeholder: "127.0.0.1:18080" },
      { path: `${channel}.webhook_path`, label: "Webhook path", type: "string" },
    );
  }
  if (options.poll) fields.push({ path: `${channel}.poll_timeout`, label: "Poll timeout", type: "string", duration: true, editor: "duration" });
  fields.push(
    { path: `${channel}.task_timeout`, label: "Task timeout", type: "string", duration: true, editor: "duration", zeroLabel: "Same as run timeout" },
    { path: `${channel}.max_concurrency`, label: "Maximum concurrency", type: "int" },
    { path: `${channel}.serve_listen`, label: "Runtime API listen address", type: "string", validate: "listen", placeholder: "127.0.0.1:8787" },
  );
  return { id: channel, title: `${title} behavior`, fields };
}

export const CHANNEL_CONFIG_GROUPS = [
  channelFields("telegram", { title: "Telegram", poll: true }),
  channelFields("slack", { title: "Slack", baseURL: true }),
  channelFields("line", { title: "LINE", baseURL: true, webhook: true }),
  channelFields("lark", { title: "Lark", baseURL: true }),
  channelFields("mixin", { title: "Mixin", group: false }),
  channelFields("discord", { title: "Discord", baseURL: true }),
  channelFields("wechat", { title: "WeChat" }),
  channelFields("whatsapp", { title: "WhatsApp" }),
];

// Group trigger fields, shown in the channel's pane under its trigger mode (not in Advanced).
function channelTriggerFields(channel, title) {
  return {
    id: channel,
    title: `${title} group trigger`,
    fields: [
      { path: `${channel}.addressing_confidence_threshold`, label: "Addressing confidence threshold", type: "float", editor: "percent" },
      { path: `${channel}.addressing_interject_threshold`, label: "Addressing interject threshold", type: "float", editor: "percent" },
      { path: `${channel}.record_untriggered`, label: "Record all group messages", type: "bool" },
    ],
  };
}

export const CHANNEL_TRIGGER_CONFIG_GROUPS = [
  channelTriggerFields("telegram", "Telegram"),
  channelTriggerFields("slack", "Slack"),
  channelTriggerFields("line", "LINE"),
  channelTriggerFields("lark", "Lark"),
  channelTriggerFields("discord", "Discord"),
];

// Heartbeat is a built-in cron task, so the scheduler switch comes first and gates it.
export const AUTOMATION_CONFIG_GROUPS = [
  {
    id: "automation",
    title: "Automation",
    fields: [
      {
        path: "cron.enabled",
        label: "TODO scheduler",
        type: "bool",
        note: "Runs scheduled and recurring TODOs when they are due. Heartbeat also runs on this scheduler.",
      },
      {
        path: "heartbeat.enabled",
        label: "Heartbeat",
        type: "bool",
        dependsOn: "cron.enabled",
        note: "Wakes Morph at a fixed interval to work through the checks in HEARTBEAT.md.",
      },
      {
        path: "heartbeat.interval",
        label: "Heartbeat interval",
        type: "select",
        options: HEARTBEAT_INTERVAL_OPTIONS,
        allowCustom: true,
        duration: true,
        dependsOn: "heartbeat.enabled",
      },
    ],
  },
];

export const SECURITY_CONFIG_GROUPS = [
  {
    id: "guard-storage",
    title: "Guard details",
    fields: [
      { path: "guard.dir_name", label: "Guard directory name", type: "string" },
      { path: "guard.redaction.patterns", label: "Additional redaction patterns", type: "json", wide: true, editor: "rows", rows: "patterns", addLabel: "Add pattern" },
      { path: "guard.audit.jsonl_path", label: "Audit JSONL path", type: "string", wide: true, placeholder: "<state directory>/<guard directory>/audit/guard_audit.jsonl" },
      { path: "guard.audit.rotate_max_bytes", label: "Audit rotation size", type: "int", editor: "bytes" },
    ],
  },
  {
    id: "administrators",
    title: "Administrators",
    fields: [
      {
        path: "admins",
        label: "Admin identities",
        type: "string_list",
        wide: true,
        editor: "rows",
        rows: "identities",
        platforms: ADMIN_PLATFORM_OPTIONS,
        addLabel: "Add admin",
        note: "People allowed to start Agent pairing in a private chat. Telegram usernames must already be in Contacts.",
      },
    ],
  },
  {
    id: "secret-sources",
    title: "Secret sources",
    fields: [
      { path: "secrets.allow_profiles", label: "Allowed auth profiles", type: "string_list", wide: true, options: [], note: "Auth profiles that tools may use. None are allowed by default." },
      { path: "secrets.aws_secrets_manager.region", label: "AWS Secrets Manager region", type: "select", options: AWS_REGION_OPTIONS, allowCustom: true, placeholder: "Not set" },
      { path: "secrets.aws_secrets_manager.profile", label: "AWS profile", type: "string" },
    ],
  },
];

export const SYSTEM_CONFIG_GROUPS = [
  {
    id: "logging",
    title: "Logging",
    fields: [
      { path: "logging.level", label: "Level", type: "select", options: LOGGING_LEVEL_OPTIONS },
      { path: "logging.format", label: "Format", type: "select", options: ["text", "json"] },
    ],
  },
];

export const SYSTEM_ADVANCED_CONFIG_GROUPS = [
  {
    id: "logging-details",
    title: "Logging details",
    fields: [
      { path: "logging.add_source", label: "Include source location", type: "bool" },
      { path: "logging.file.dir", label: "Log directory", type: "string", wide: true, editor: "directory", placeholder: "<state directory>/logs" },
      { path: "logging.file.max_age", label: "Log retention", type: "string", duration: true, editor: "duration" },
      { path: "logging.include_thoughts", label: "Include thoughts", type: "bool" },
      { path: "logging.include_tool_params", label: "Include tool parameters", type: "bool" },
      { path: "logging.include_skill_contents", label: "Include skill contents", type: "bool" },
      { path: "logging.max_thought_chars", label: "Maximum thought characters", type: "int", dependsOn: "logging.include_thoughts" },
      { path: "logging.max_json_bytes", label: "Maximum JSON size", type: "int", editor: "bytes" },
      { path: "logging.max_string_value_chars", label: "Maximum string characters", type: "int" },
      { path: "logging.max_skill_content_chars", label: "Maximum skill content characters", type: "int", dependsOn: "logging.include_skill_contents" },
      { path: "logging.redact_keys", label: "Additional redacted keys", type: "string_list", wide: true, editor: "rows", placeholder: "session_token", addLabel: "Add key" },
    ],
  },
  {
    id: "paths-storage",
    title: "Paths and storage",
    fields: [
      { path: "workspace_dir", label: "Default workspace directory", type: "string", wide: true, editor: "directory", placeholder: "None. Topics without a workspace have no project directory." },
      { path: "file_state_dir", label: "State directory", type: "string", wide: true, editor: "directory", placeholder: "~/.morph" },
      { path: "file_cache_dir", label: "File cache directory", type: "string", wide: true, editor: "directory", placeholder: "~/.cache/morph" },
      { path: "file_cache.max_age", label: "File cache maximum age", type: "string", duration: true, editor: "duration" },
      { path: "file_cache.max_files", label: "File cache maximum files", type: "int" },
      { path: "file_cache.max_total_bytes", label: "File cache maximum size", type: "int", editor: "bytes" },
      { path: "contacts.dir_name", label: "Contacts directory name", type: "string" },
      { path: "contacts.proactive.failure_cooldown", label: "Contact failure cooldown", type: "string", duration: true, editor: "duration" },
      { path: "tasks.dir_name", label: "Tasks directory name", type: "string" },
      { path: "tasks.persistence_targets", label: "Task persistence targets", type: "string_list", options: TASK_TARGET_OPTIONS, wide: true },
      { path: "tasks.rotate_max_bytes", label: "Task journal rotation size", type: "int", editor: "bytes" },
    ],
  },
  {
    id: "runtime-capacity",
    title: "Runtime capacity",
    fields: [
      { path: "server.max_queue", label: "Maximum queued tasks", type: "int" },
      { path: "bus.max_inflight", label: "Maximum in-flight bus messages", type: "int" },
      { path: "user_agent", label: "Outbound User-Agent", type: "string", wide: true },
    ],
  },
];

export const REMOTE_CONTROL_CONFIG_GROUPS = [
  {
    id: "incoming-control",
    title: "This Morph",
    note: "Allow another Morph Console or API client to control this Morph through /runtime. Leave the token empty to keep incoming remote control disabled.",
    fields: [
      {
        path: "server.auth_token",
        label: "Incoming access token",
        type: "string",
        secret: true,
        wide: true,
        note: "Clients send this value as a Bearer token. It is separate from Web Console sign-in.",
      },
    ],
  },
];

export const CONSOLE_DEPLOYMENT_CONFIG_GROUPS = [
  {
    id: "web-console-deployment",
    title: "Web Console",
    note: "Browser entry point and session settings. These do not authenticate Runtime API clients.",
    fields: [
      { path: "console.listen", label: "Listen address", type: "string", validate: "listen", placeholder: "127.0.0.1:9080" },
      { path: "console.base_path", label: "Base path", type: "string", placeholder: "/" },
      { path: "console.session_ttl", label: "Browser session lifetime", type: "string", duration: true, editor: "duration" },
      {
        path: "console.static_dir",
        label: "Static files directory",
        type: "string",
        wide: true,
        editor: "directory",
        note: "Optional override for custom Web Console build files.",
      },
    ],
  },
];
