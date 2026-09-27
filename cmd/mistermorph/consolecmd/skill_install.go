package consolecmd

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/tools"
)

// skillInstallTools are console-only: the web console is where the user reads the preview and
// approves the install.
func (r *consoleLocalRuntime) skillInstallTools(generation *consoleLocalRuntimeGeneration) []tools.Tool {
	if generation == nil || generation.bundle == nil || generation.bundle.taskRuntime == nil {
		return nil
	}
	reader := generation.reader
	stateDir := generation.paths.StateDir
	client := generation.bundle.taskRuntime.BootstrapMainClient
	model := generation.bundle.defaultModel
	preview, install := skillinstall.NewTools(skillinstall.ToolDeps{
		Service: skillinstall.DefaultService(),
		Store:   skillinstall.DefaultStore(),
		Options: func(context.Context) (skillinstall.Options, error) {
			roots := skillsutil.SkillsConfigFromReader(reader).Roots
			if len(roots) == 0 || strings.TrimSpace(stateDir) == "" {
				return skillinstall.Options{}, errors.New("skill install needs a skills folder and a state folder")
			}
			return skillinstall.Options{
				SkillsRoot: roots[0],
				StagingDir: filepath.Join(stateDir, "skill_install_staging"),
				Review:     skillinstall.LLMReviewer(client, model),
				Enable:     r.enableInstalledSkill,
			}, nil
		},
		StoreIndexURL: func() string { return skillStoreIndexURL(reader) },
	})
	return []tools.Tool{preview, install}
}

// enableInstalledSkill switches a new skill on through the settings file, like the Skills page.
func (r *consoleLocalRuntime) enableInstalledSkill(ctx context.Context, skillID string) error {
	fn := r.skillEnabler
	if fn == nil {
		return errors.New("settings are not writable here")
	}
	return fn(ctx, skillID)
}

func skillStoreIndexURL(reader interface{ GetString(string) string }) string {
	if reader != nil {
		if url := strings.TrimSpace(reader.GetString("skills.store.index_url")); url != "" {
			return url
		}
	}
	return skillinstall.DefaultStoreIndexURL
}

func (s *server) enableSkill(ctx context.Context, skillID string) error {
	s.settingsWriteMu.Lock()
	defer s.settingsWriteMu.Unlock()
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		return err
	}
	owner := agentsettings.NewFileOwner(agentsettings.FileOwnerOptions{
		ConfigPath: configPath,
		Reader:     s.currentRuntimeConfigReader(),
		OSStore:    s.secretStore,
	})
	return agentsettings.EnableSkill(ctx, owner, skillID)
}

func (s *server) handleAgentSkillStore(w http.ResponseWriter, r *http.Request) {
	handler, err := s.agentSkillsHandler()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	handler.SkillStore(w, r)
}

func (s *server) handleAgentSkillRemove(w http.ResponseWriter, r *http.Request) {
	s.settingsWriteMu.Lock()
	defer s.settingsWriteMu.Unlock()
	handler, err := s.agentSkillsHandler()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	handler.RemoveSkillRoute(w, r)
}
