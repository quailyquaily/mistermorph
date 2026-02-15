package integration

import (
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/secrets"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
	"github.com/spf13/viper"
)

func (rt *Runtime) buildRegistryFromViper() *tools.Registry {
	r := tools.NewRegistry()
	if rt == nil {
		return r
	}
	selectedBuiltinTools := make(map[string]struct{}, len(rt.cfg.BuiltinToolNames))
	for _, name := range rt.cfg.BuiltinToolNames {
		selectedBuiltinTools[name] = struct{}{}
		if _, ok := knownBuiltinToolNames[name]; !ok {
			slog.Default().Warn("unknown_builtin_tool_name", "name", name)
		}
	}
	isToolSelected := func(name string) bool {
		if len(selectedBuiltinTools) == 0 {
			return true
		}
		_, ok := selectedBuiltinTools[name]
		return ok
	}

	viper.SetDefault("tools.read_file.max_bytes", 256*1024)
	viper.SetDefault("tools.read_file.deny_paths", []string{"config.yaml"})

	viper.SetDefault("tools.write_file.enabled", true)
	viper.SetDefault("tools.write_file.max_bytes", 512*1024)

	viper.SetDefault("tools.bash.enabled", true)
	viper.SetDefault("tools.bash.timeout", 30*time.Second)
	viper.SetDefault("tools.bash.max_output_bytes", 256*1024)
	viper.SetDefault("tools.bash.deny_paths", []string{"config.yaml"})

	viper.SetDefault("tools.url_fetch.enabled", true)
	viper.SetDefault("tools.url_fetch.timeout", 30*time.Second)
	viper.SetDefault("tools.url_fetch.max_bytes", int64(512*1024))
	viper.SetDefault("tools.url_fetch.max_bytes_download", int64(100*1024*1024))
	viper.SetDefault("tools.web_search.enabled", true)
	viper.SetDefault("tools.web_search.timeout", 20*time.Second)
	viper.SetDefault("tools.web_search.max_results", 5)
	viper.SetDefault("tools.web_search.base_url", "https://duckduckgo.com/html/")
	viper.SetDefault("tools.contacts.enabled", true)
	viper.SetDefault("tools.todo.enabled", true)

	userAgent := strings.TrimSpace(viper.GetString("user_agent"))

	secretsEnabled := viper.GetBool("secrets.enabled")
	secretsRequireSkillProfiles := viper.GetBool("secrets.require_skill_profiles")

	allowProfiles := make(map[string]bool)
	for _, id := range viper.GetStringSlice("secrets.allow_profiles") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		allowProfiles[id] = true
	}

	var authProfiles map[string]secrets.AuthProfile
	_ = viper.UnmarshalKey("auth_profiles", &authProfiles)
	for id, p := range authProfiles {
		p.ID = id
		authProfiles[id] = p
	}

	for _, p := range authProfiles {
		if err := p.Validate(); err != nil {
			slog.Default().Warn("auth_profile_invalid", "profile", p.ID, "err", err)
			delete(authProfiles, p.ID)
		}
	}

	if secretsEnabled {
		slog.Default().Info("secrets_enabled",
			"require_skill_profiles", secretsRequireSkillProfiles,
			"allow_profiles", keysSorted(allowProfiles),
			"auth_profiles", len(authProfiles),
		)
	} else {
		if len(allowProfiles) > 0 || len(authProfiles) > 0 {
			slog.Default().Warn("secrets_disabled_but_configured",
				"allow_profiles", keysSorted(allowProfiles),
				"auth_profiles", len(authProfiles),
			)
		}
	}

	secretsAliases := make(map[string]string)
	_ = viper.UnmarshalKey("secrets.aliases", &secretsAliases)
	resolver := &secrets.EnvResolver{Aliases: secretsAliases}
	profileStore := secrets.NewProfileStore(authProfiles)

	if isToolSelected("read_file") {
		r.Register(builtin.NewReadFileToolWithDenyPaths(
			int64(viper.GetInt("tools.read_file.max_bytes")),
			viper.GetStringSlice("tools.read_file.deny_paths"),
			strings.TrimSpace(viper.GetString("file_cache_dir")),
			strings.TrimSpace(viper.GetString("file_state_dir")),
		))
	}

	if isToolSelected("write_file") {
		r.Register(builtin.NewWriteFileTool(
			viper.GetBool("tools.write_file.enabled"),
			viper.GetInt("tools.write_file.max_bytes"),
			strings.TrimSpace(viper.GetString("file_cache_dir")),
			strings.TrimSpace(viper.GetString("file_state_dir")),
		))
	}

	if isToolSelected("bash") && viper.GetBool("tools.bash.enabled") {
		bt := builtin.NewBashTool(
			true,
			viper.GetDuration("tools.bash.timeout"),
			viper.GetInt("tools.bash.max_output_bytes"),
		)
		bt.DenyPaths = viper.GetStringSlice("tools.bash.deny_paths")
		if secretsEnabled {
			bt.DenyTokens = append(bt.DenyTokens, "curl")
		}
		r.Register(bt)
	}

	if isToolSelected("url_fetch") && viper.GetBool("tools.url_fetch.enabled") {
		r.Register(builtin.NewURLFetchToolWithAuthLimits(
			true,
			viper.GetDuration("tools.url_fetch.timeout"),
			viper.GetInt64("tools.url_fetch.max_bytes"),
			viper.GetInt64("tools.url_fetch.max_bytes_download"),
			userAgent,
			strings.TrimSpace(viper.GetString("file_cache_dir")),
			&builtin.URLFetchAuth{
				Enabled:       secretsEnabled,
				AllowProfiles: allowProfiles,
				Profiles:      profileStore,
				Resolver:      resolver,
			},
		))
	}

	if isToolSelected("web_search") && viper.GetBool("tools.web_search.enabled") {
		r.Register(builtin.NewWebSearchTool(
			true,
			viper.GetString("tools.web_search.base_url"),
			viper.GetDuration("tools.web_search.timeout"),
			viper.GetInt("tools.web_search.max_results"),
			userAgent,
		))
	}

	if isToolSelected("todo_update") && viper.GetBool("tools.todo.enabled") {
		r.Register(builtin.NewTodoUpdateTool(
			true,
			statepaths.TODOWIPPath(),
			statepaths.TODODONEPath(),
			statepaths.ContactsDir(),
		))
	}

	if isToolSelected("contacts_send") && viper.GetBool("tools.contacts.enabled") {
		r.Register(builtin.NewContactsSendTool(builtin.ContactsSendToolOptions{
			Enabled:          true,
			ContactsDir:      statepaths.ContactsDir(),
			MAEPDir:          statepaths.MAEPDir(),
			TelegramBotToken: strings.TrimSpace(viper.GetString("telegram.bot_token")),
			TelegramBaseURL:  "https://api.telegram.org",
			FailureCooldown:  contactsFailureCooldown(),
		}))
	}

	return r
}

func contactsFailureCooldown() time.Duration {
	if viper.IsSet("contacts.proactive.failure_cooldown") {
		if v := viper.GetDuration("contacts.proactive.failure_cooldown"); v > 0 {
			return v
		}
	}
	return 72 * time.Hour
}

func keysSorted(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var knownBuiltinToolNames = map[string]struct{}{
	"read_file":     {},
	"write_file":    {},
	"bash":          {},
	"url_fetch":     {},
	"web_search":    {},
	"todo_update":   {},
	"contacts_send": {},
}
