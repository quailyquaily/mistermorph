// Package statefiles writes the agent's state as the files it was before agent.db (config.yaml,
// persona/identity.yaml, persona/soul.md, HEARTBEAT.md, contacts/ACTIVE.md and INACTIVE.md,
// cron.yaml), and reads such files back, for `morph state export` and `morph state import`. The
// files can be edited by hand or kept in git.
package statefiles

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// The files, relative to the export folder.
var (
	ConfigFile    = "config.yaml"
	IdentityFile  = filepath.Join(statepaths.PersonaDirName, statepaths.IdentityFilename)
	SoulFile      = filepath.Join(statepaths.PersonaDirName, statepaths.SoulFilename)
	HeartbeatFile = statepaths.HeartbeatChecklistFilename
	ActiveFile    = filepath.Join("contacts", contacts.ActiveContactsFile)
	InactiveFile  = filepath.Join("contacts", contacts.InactiveContactsFile)
	CronFile      = statepaths.CronFilename
)

// Locations say where the state is: the config (agent.db's or a file), the state folder, the
// contacts folder and the TODO list (named by its cron.yaml path).
type Locations struct {
	ConfigPath  string
	StateDir    string
	ContactsDir string
	CronPath    string
}

// Result lists the files written or read.
type Result struct {
	Files []string
}

func write(dir, rel, content string, result *Result) error {
	if err := fsstore.WriteTextAtomic(filepath.Join(dir, rel), content, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600}); err != nil {
		return err
	}
	result.Files = append(result.Files, filepath.ToSlash(rel))
	return nil
}

// Export writes the state into dir as files.
func Export(ctx context.Context, loc Locations, dir string) (Result, error) {
	var result Result
	dir = filepath.Clean(strings.TrimSpace(dir))
	if dir == "" || dir == "." {
		return result, fmt.Errorf("an export folder is required")
	}
	if err := fsstore.EnsureDir(dir, 0o700); err != nil {
		return result, err
	}
	if config, err := configstore.ReadFile(loc.ConfigPath); err == nil {
		if err := write(dir, ConfigFile, string(config), &result); err != nil {
			return result, err
		}
	} else if !os.IsNotExist(err) {
		return result, err
	}

	persona, err := personastore.Open(ctx, loc.StateDir)
	if err != nil {
		return result, err
	}
	defer func() { _ = persona.Close() }()
	if id, ok, err := persona.Identity(ctx); err != nil {
		return result, err
	} else if ok {
		if err := write(dir, IdentityFile, personastore.RenderIdentityYAML(id), &result); err != nil {
			return result, err
		}
		if soul := personastore.RenderSoul(id.Soul); soul != "" {
			if err := write(dir, SoulFile, soul, &result); err != nil {
				return result, err
			}
		}
	}
	workflows, err := persona.Workflows(ctx)
	if err != nil {
		return result, err
	}
	if err := write(dir, HeartbeatFile, personastore.RenderChecklist(workflows), &result); err != nil {
		return result, err
	}

	listed, err := contacts.NewStore(loc.ContactsDir).ListContactsFiltered(ctx, contacts.ContactFilter{})
	if err != nil {
		return result, err
	}
	active, inactive, err := contacts.RenderContactsFiles(listed)
	if err != nil {
		return result, err
	}
	if err := write(dir, ActiveFile, active, &result); err != nil {
		return result, err
	}
	if err := write(dir, InactiveFile, inactive, &result); err != nil {
		return result, err
	}

	file, _, err := cronstore.NewStore(loc.CronPath).Read()
	if err != nil {
		return result, err
	}
	text, err := cronstore.RenderFile(file)
	if err != nil {
		return result, err
	}
	if err := write(dir, CronFile, text, &result); err != nil {
		return result, err
	}
	return result, nil
}

func read(dir, rel string) (string, bool, error) {
	raw, err := os.ReadFile(filepath.Join(dir, rel))
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(raw), true, nil
}

// Import reads the files Export writes back from dir, each into its store in one transaction. A
// file that is not there leaves its store as it is. Every file is parsed before anything is saved.
func Import(ctx context.Context, loc Locations, dir string) (Result, error) {
	var result Result
	dir = filepath.Clean(strings.TrimSpace(dir))

	config, hasConfig, err := read(dir, ConfigFile)
	if err != nil {
		return result, err
	}
	identityText, hasIdentity, err := read(dir, IdentityFile)
	if err != nil {
		return result, err
	}
	soulText, hasSoul, err := read(dir, SoulFile)
	if err != nil {
		return result, err
	}
	var identity personastore.Identity
	if hasIdentity {
		if identity, err = personastore.ParseIdentityYAML(identityText); err != nil {
			return result, fmt.Errorf("%s: %w", IdentityFile, err)
		}
	}
	heartbeatText, hasHeartbeat, err := read(dir, HeartbeatFile)
	if err != nil {
		return result, err
	}
	activeText, hasActive, err := read(dir, ActiveFile)
	if err != nil {
		return result, err
	}
	inactiveText, hasInactive, err := read(dir, InactiveFile)
	if err != nil {
		return result, err
	}
	var listed []contacts.ListedContact
	for _, source := range []struct {
		text   string
		status contacts.Status
		rel    string
	}{{activeText, contacts.StatusActive, ActiveFile}, {inactiveText, contacts.StatusInactive, InactiveFile}} {
		items, err := contacts.ParseContactsFile(source.text)
		if err != nil {
			return result, fmt.Errorf("%s: %w", source.rel, err)
		}
		for _, item := range items {
			listed = append(listed, contacts.ListedContact{Contact: item, Status: source.status})
		}
	}
	cronText, hasCron, err := read(dir, CronFile)
	if err != nil {
		return result, err
	}
	var cronFile cronstore.File
	if hasCron {
		if cronFile, err = cronstore.ParseFile(cronText); err != nil {
			return result, fmt.Errorf("%s: %w", CronFile, err)
		}
		if err := cronstore.ValidateFile(cronFile); err != nil {
			return result, fmt.Errorf("%s: %w", CronFile, err)
		}
	}

	if hasConfig {
		if err := configstore.WriteFileBy(loc.ConfigPath, []byte(config), configstore.ByImport); err != nil {
			return result, fmt.Errorf("%s: %w", ConfigFile, err)
		}
		result.Files = append(result.Files, ConfigFile)
	}
	persona, err := personastore.Open(ctx, loc.StateDir)
	if err != nil {
		return result, err
	}
	defer func() { _ = persona.Close() }()
	if hasIdentity || hasSoul {
		current, _, err := persona.Identity(ctx)
		if err != nil {
			return result, err
		}
		if hasIdentity {
			identity.Soul = current.Soul
			current = identity
			result.Files = append(result.Files, filepath.ToSlash(IdentityFile))
		}
		if hasSoul {
			current.Soul = personastore.ParseSoul(soulText)
			result.Files = append(result.Files, filepath.ToSlash(SoulFile))
		}
		if _, err := persona.SaveIdentity(ctx, current, personastore.ByImport); err != nil {
			return result, err
		}
	}
	if hasHeartbeat {
		existing, err := persona.Workflows(ctx)
		if err != nil {
			return result, err
		}
		if _, err := persona.ReplaceWorkflows(ctx, personastore.MatchWorkflowIDs(personastore.ParseChecklist(heartbeatText), existing)); err != nil {
			return result, fmt.Errorf("%s: %w", HeartbeatFile, err)
		}
		result.Files = append(result.Files, HeartbeatFile)
	}
	if hasActive || hasInactive {
		if err := contacts.NewStore(loc.ContactsDir).ReplaceAll(ctx, listed); err != nil {
			return result, fmt.Errorf("contacts: %w", err)
		}
		if hasActive {
			result.Files = append(result.Files, filepath.ToSlash(ActiveFile))
		}
		if hasInactive {
			result.Files = append(result.Files, filepath.ToSlash(InactiveFile))
		}
	}
	if hasCron {
		if err := cronstore.NewStore(loc.CronPath).Write(cronFile); err != nil {
			return result, fmt.Errorf("%s: %w", CronFile, err)
		}
		result.Files = append(result.Files, CronFile)
	}
	return result, nil
}
