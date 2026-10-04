// Where a stored secret lives, from the source the runtime reports for it. Agent settings and the
// config settings name the same places differently.
export function secretStorageKind(source) {
  switch (String(source || "").trim()) {
    case "os":
    case "config_os_ref":
      return "os";
    case "file":
      return "file";
    case "env":
    case "config_env_ref":
    case "environment_override":
    case "runtime_override":
      return "env";
    case "aws-sm":
    case "config_aws_ref":
      return "aws";
    default:
      return "stored";
  }
}

// Where an LLM form's secret field sits in config.yaml, under llm (or llm.profiles.<name>).
const LLM_SECRET_CONFIG_PATHS = {
  api_key: "api_key",
  cloudflare_api_token: "cloudflare.api_token",
  bedrock_aws_key: "bedrock.aws_key",
  bedrock_aws_secret: "bedrock.aws_secret",
  bedrock_aws_session_token: "bedrock.aws_session_token",
};

export function llmSecretConfigPath(prefix, field) {
  const sub = LLM_SECRET_CONFIG_PATHS[field];
  return prefix && sub ? `${prefix}.${sub}` : "";
}
