package integration

import (
	"log/slog"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/secrets"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

func (rt *Runtime) buildRegistry(cfg registrySnapshot, logger *slog.Logger) *tools.Registry {
	r := tools.NewRegistry()
	if rt == nil {
		return r
	}
	if logger == nil {
		logger = slog.Default()
	}

	selectedBuiltinTools := make(map[string]struct{}, len(rt.builtinToolNames))
	for _, name := range rt.builtinToolNames {
		selectedBuiltinTools[name] = struct{}{}
		if _, ok := knownBuiltinToolNames[name]; !ok {
			logger.Warn("unknown_builtin_tool_name", "name", name)
		}
	}
	isToolSelected := func(name string) bool {
		if len(selectedBuiltinTools) == 0 {
			return true
		}
		_, ok := selectedBuiltinTools[name]
		return ok
	}

	userAgent := strings.TrimSpace(cfg.UserAgent)
	secretsEnabled := cfg.SecretsEnabled
	secretsRequireSkillProfiles := cfg.SecretsRequireSkillProfiles

	allowProfiles := make(map[string]bool)
	for _, id := range cfg.SecretsAllowProfiles {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		allowProfiles[id] = true
	}

	authProfiles := copyAuthProfilesMap(cfg.AuthProfiles)

	for _, p := range authProfiles {
		if err := p.Validate(); err != nil {
			logger.Warn("auth_profile_invalid", "profile", p.ID, "err", err)
			delete(authProfiles, p.ID)
		}
	}

	if secretsEnabled {
		logger.Info("secrets_enabled",
			"require_skill_profiles", secretsRequireSkillProfiles,
			"allow_profiles", keysSorted(allowProfiles),
			"auth_profiles", len(authProfiles),
		)
	} else {
		if len(allowProfiles) > 0 || len(authProfiles) > 0 {
			logger.Warn("secrets_disabled_but_configured",
				"allow_profiles", keysSorted(allowProfiles),
				"auth_profiles", len(authProfiles),
			)
		}
	}

	secretsAliases := copyStringMap(cfg.SecretsAliases)
	resolver := &secrets.EnvResolver{Aliases: secretsAliases}
	profileStore := secrets.NewProfileStore(authProfiles)

	if isToolSelected("read_file") {
		r.Register(builtin.NewReadFileToolWithDenyPaths(
			cfg.ToolsReadFileMaxBytes,
			append([]string(nil), cfg.ToolsReadFileDenyPaths...),
			strings.TrimSpace(cfg.FileCacheDir),
			strings.TrimSpace(cfg.FileStateDir),
		))
	}

	if isToolSelected("write_file") && cfg.ToolsWriteFileEnabled {
		r.Register(builtin.NewWriteFileTool(
			true,
			cfg.ToolsWriteFileMaxBytes,
			strings.TrimSpace(cfg.FileCacheDir),
			strings.TrimSpace(cfg.FileStateDir),
		))
	}

	if isToolSelected("bash") && cfg.ToolsBashEnabled {
		bt := builtin.NewBashTool(
			true,
			cfg.ToolsBashTimeout,
			cfg.ToolsBashMaxOutputBytes,
			strings.TrimSpace(cfg.FileCacheDir),
			strings.TrimSpace(cfg.FileStateDir),
		)
		bt.DenyPaths = append([]string(nil), cfg.ToolsBashDenyPaths...)
		if secretsEnabled {
			bt.DenyTokens = append(bt.DenyTokens, "curl")
		}
		r.Register(bt)
	}

	if isToolSelected("url_fetch") && cfg.ToolsURLFetchEnabled {
		r.Register(builtin.NewURLFetchToolWithAuthLimits(
			true,
			cfg.ToolsURLFetchTimeout,
			cfg.ToolsURLFetchMaxBytes,
			cfg.ToolsURLFetchMaxBytesDownload,
			userAgent,
			strings.TrimSpace(cfg.FileCacheDir),
			&builtin.URLFetchAuth{
				Enabled:       secretsEnabled,
				AllowProfiles: allowProfiles,
				Profiles:      profileStore,
				Resolver:      resolver,
			},
		))
	}

	if isToolSelected("web_search") && cfg.ToolsWebSearchEnabled {
		r.Register(builtin.NewWebSearchTool(
			true,
			cfg.ToolsWebSearchBaseURL,
			cfg.ToolsWebSearchTimeout,
			cfg.ToolsWebSearchMaxResults,
			userAgent,
		))
	}

	if isToolSelected("todo_update") && cfg.ToolsTodoUpdateEnabled {
		r.Register(builtin.NewTodoUpdateTool(
			true,
			cfg.TODOPathWIP,
			cfg.TODOPathDone,
			cfg.ContactsDir,
		))
	}

	if isToolSelected("contacts_send") && cfg.ToolsContactsEnabled {
		r.Register(builtin.NewContactsSendTool(builtin.ContactsSendToolOptions{
			Enabled:          true,
			ContactsDir:      cfg.ContactsDir,
			MAEPDir:          cfg.MAEPDir,
			TelegramBotToken: strings.TrimSpace(cfg.TelegramBotToken),
			TelegramBaseURL:  strings.TrimSpace(cfg.TelegramBaseURL),
			SlackBotToken:    strings.TrimSpace(cfg.SlackBotToken),
			SlackBaseURL:     strings.TrimSpace(cfg.SlackBaseURL),
			FailureCooldown:  cfg.ContactsFailureCooldown,
		}))
	}

	return r
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
