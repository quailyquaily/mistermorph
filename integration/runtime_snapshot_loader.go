package integration

import (
	"log/slog"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/logutil"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/secrets"
	"github.com/spf13/viper"
)

func loadRuntimeSnapshot(cfg Config) runtimeSnapshot {
	v := viper.New()
	applyViperDefaults(v)
	for k, value := range cfg.Overrides {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		v.Set(key, value)
	}
	return loadRuntimeSnapshotFromReader(v)
}

func loadRuntimeSnapshotFromReader(v *viper.Viper) runtimeSnapshot {
	if v == nil {
		v = viper.New()
		applyViperDefaults(v)
	}

	fileStateDir := strings.TrimSpace(v.GetString("file_state_dir"))

	secretsAliases := map[string]string{}
	_ = v.UnmarshalKey("secrets.aliases", &secretsAliases)

	authProfiles := map[string]secrets.AuthProfile{}
	_ = v.UnmarshalKey("auth_profiles", &authProfiles)
	for id, profile := range authProfiles {
		profile.ID = id
		authProfiles[id] = profile
	}

	var guardPatterns []guard.RegexPattern
	_ = v.UnmarshalKey("guard.redaction.patterns", &guardPatterns)

	logger, loggerErr := logutil.LoggerFromConfig(logutil.LoggerConfigFromReader(v))
	if loggerErr != nil {
		logger = slog.Default()
	}
	logOpts := cloneLogOptions(logutil.LogOptionsFromConfig(logutil.LogOptionsConfigFromReader(v)))
	llmValues := llmutil.RuntimeValuesFromReader(v)
	provider := strings.TrimSpace(llmValues.Provider)

	return runtimeSnapshot{
		Logger:                      logger,
		LoggerInitErr:               loggerErr,
		LogOptions:                  logOpts,
		LLMValues:                   llmValues,
		LLMProvider:                 provider,
		LLMEndpoint:                 llmutil.EndpointForProviderWithValues(provider, llmValues),
		LLMAPIKey:                   llmutil.APIKeyForProviderWithValues(provider, llmValues),
		LLMModel:                    llmutil.ModelForProviderWithValues(provider, llmValues),
		LLMRequestTimeout:           v.GetDuration("llm.request_timeout"),
		AgentMaxSteps:               v.GetInt("max_steps"),
		AgentParseRetries:           v.GetInt("parse_retries"),
		AgentMaxTokenBudget:         v.GetInt("max_token_budget"),
		SecretsRequireSkillProfiles: v.GetBool("secrets.require_skill_profiles"),
		SkillsConfig:                cloneSkillsConfig(skillsutil.SkillsConfigFromReader(v)),
		Registry: registrySnapshot{
			UserAgent:                     strings.TrimSpace(v.GetString("user_agent")),
			SecretsEnabled:                v.GetBool("secrets.enabled"),
			SecretsRequireSkillProfiles:   v.GetBool("secrets.require_skill_profiles"),
			SecretsAllowProfiles:          append([]string(nil), v.GetStringSlice("secrets.allow_profiles")...),
			SecretsAliases:                copyStringMap(secretsAliases),
			AuthProfiles:                  copyAuthProfilesMap(authProfiles),
			FileCacheDir:                  strings.TrimSpace(v.GetString("file_cache_dir")),
			FileStateDir:                  fileStateDir,
			ToolsReadFileMaxBytes:         int64(v.GetInt("tools.read_file.max_bytes")),
			ToolsReadFileDenyPaths:        append([]string(nil), v.GetStringSlice("tools.read_file.deny_paths")...),
			ToolsWriteFileEnabled:         v.GetBool("tools.write_file.enabled"),
			ToolsWriteFileMaxBytes:        v.GetInt("tools.write_file.max_bytes"),
			ToolsBashEnabled:              v.GetBool("tools.bash.enabled"),
			ToolsBashTimeout:              v.GetDuration("tools.bash.timeout"),
			ToolsBashMaxOutputBytes:       v.GetInt("tools.bash.max_output_bytes"),
			ToolsBashDenyPaths:            append([]string(nil), v.GetStringSlice("tools.bash.deny_paths")...),
			ToolsURLFetchEnabled:          v.GetBool("tools.url_fetch.enabled"),
			ToolsURLFetchTimeout:          v.GetDuration("tools.url_fetch.timeout"),
			ToolsURLFetchMaxBytes:         v.GetInt64("tools.url_fetch.max_bytes"),
			ToolsURLFetchMaxBytesDownload: v.GetInt64("tools.url_fetch.max_bytes_download"),
			ToolsWebSearchEnabled:         v.GetBool("tools.web_search.enabled"),
			ToolsWebSearchTimeout:         v.GetDuration("tools.web_search.timeout"),
			ToolsWebSearchMaxResults:      v.GetInt("tools.web_search.max_results"),
			ToolsWebSearchBaseURL:         v.GetString("tools.web_search.base_url"),
			ToolsContactsEnabled:          v.GetBool("tools.contacts.enabled"),
			ToolsTodoUpdateEnabled:        v.GetBool("tools.todo_update.enabled"),
			TODOPathWIP:                   pathutil.ResolveStateFile(fileStateDir, statepaths.TODOWIPFilename),
			TODOPathDone:                  pathutil.ResolveStateFile(fileStateDir, statepaths.TODODONEFilename),
			ContactsDir:                   pathutil.ResolveStateChildDir(fileStateDir, strings.TrimSpace(v.GetString("contacts.dir_name")), "contacts"),
			MAEPDir:                       pathutil.ResolveStateChildDir(fileStateDir, strings.TrimSpace(v.GetString("maep.dir_name")), "maep"),
			TelegramBotToken:              strings.TrimSpace(v.GetString("telegram.bot_token")),
			TelegramBaseURL:               "https://api.telegram.org",
			SlackBotToken:                 strings.TrimSpace(v.GetString("slack.bot_token")),
			SlackBaseURL:                  strings.TrimSpace(v.GetString("slack.base_url")),
			ContactsFailureCooldown:       contactsFailureCooldownFromReader(v),
		},
		Guard: guardSnapshot{
			Enabled: v.GetBool("guard.enabled"),
			Config: guard.Config{
				Enabled: true,
				Network: guard.NetworkConfig{
					URLFetch: guard.URLFetchNetworkPolicy{
						AllowedURLPrefixes: append([]string(nil), v.GetStringSlice("guard.network.url_fetch.allowed_url_prefixes")...),
						DenyPrivateIPs:     v.GetBool("guard.network.url_fetch.deny_private_ips"),
						FollowRedirects:    v.GetBool("guard.network.url_fetch.follow_redirects"),
						AllowProxy:         v.GetBool("guard.network.url_fetch.allow_proxy"),
					},
				},
				Redaction: guard.RedactionConfig{
					Enabled:  v.GetBool("guard.redaction.enabled"),
					Patterns: append([]guard.RegexPattern(nil), guardPatterns...),
				},
				Audit: guard.AuditConfig{
					JSONLPath:      strings.TrimSpace(v.GetString("guard.audit.jsonl_path")),
					RotateMaxBytes: v.GetInt64("guard.audit.rotate_max_bytes"),
				},
				Approvals: guard.ApprovalsConfig{
					Enabled: v.GetBool("guard.approvals.enabled"),
				},
			},
			Dir: pathutil.ResolveStateChildDir(fileStateDir, strings.TrimSpace(v.GetString("guard.dir_name")), "guard"),
		},
		Telegram: channelopts.TelegramConfigFromReader(v),
		Slack:    channelopts.SlackConfigFromReader(v),
	}
}

func contactsFailureCooldownFromReader(v *viper.Viper) time.Duration {
	if v == nil {
		return 72 * time.Hour
	}
	if v.IsSet("contacts.proactive.failure_cooldown") {
		if value := v.GetDuration("contacts.proactive.failure_cooldown"); value > 0 {
			return value
		}
	}
	return 72 * time.Hour
}
