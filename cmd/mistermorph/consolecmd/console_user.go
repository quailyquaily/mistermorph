package consolecmd

import (
	"os"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/configrevision"
	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/consoleuser"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// consoleUserNameField is console.user_name as the config registry has it.
func consoleUserNameField() configsettings.Field {
	for _, field := range configsettings.ConsoleFields() {
		if field.Path == consoleuser.ConfigKey {
			return field
		}
	}
	return configsettings.Field{Path: consoleuser.ConfigKey, Kind: configsettings.KindString, ApplyMode: configsettings.ApplyImmediate, Normalize: consoleuser.NormalizeName}
}

// consoleUserNameSource reads the saved name of the Console's human from the Console's config. It
// is the one source of that name: the session API answers from it and each new task takes its
// sender's name from it, so a saved change shows in both at once.
type consoleUserNameSource struct {
	mu       sync.Mutex
	revision string
	env      string
	name     string
	cached   bool
}

// saved is the saved name, or "" when none is saved or the saved text is not a valid name.
func (c *consoleUserNameSource) saved() string {
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		return ""
	}
	snapshot, err := configrevision.Read(configPath)
	if err != nil {
		return ""
	}
	field := consoleUserNameField()
	env, _ := os.LookupEnv("MISTER_MORPH_" + strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(field.Path)))
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cached && c.revision == snapshot.Revision && c.env == env {
		return c.name
	}
	name := ""
	if view, err := configsettings.View(snapshot.Data, []configsettings.Field{field}); err == nil {
		if text, ok := view.Values[field.Path].(string); ok {
			if normalized, err := consoleuser.NormalizeName(text); err == nil {
				name = normalized
			}
		}
	}
	c.revision, c.env, c.name, c.cached = snapshot.Revision, env, name, true
	return name
}

// displayName is the name new tasks record for the Console's human.
func (c *consoleUserNameSource) displayName() string {
	return consoleuser.DisplayName(c.saved())
}

// consoleUserDisplayName is the name the runtime records for the Console's human on a task
// accepted now: the saved name, or the default without one.
func (r *consoleLocalRuntime) consoleUserDisplayName() string {
	if r != nil && r.userDisplayName != nil {
		if name := strings.TrimSpace(r.userDisplayName()); name != "" {
			return name
		}
	}
	return consoleDisplayName
}

// consoleUserNameOfConversation is the name a task recorded for the Console's human, or "" for a
// task that recorded none.
func consoleUserNameOfConversation(conversation *taskdomain.TaskConversation) string {
	if conversation == nil {
		return ""
	}
	for _, participant := range conversation.Participants {
		if strings.EqualFold(strings.TrimSpace(participant.ID), consoleParticipantKey) {
			return strings.TrimSpace(participant.Nickname)
		}
	}
	return ""
}
