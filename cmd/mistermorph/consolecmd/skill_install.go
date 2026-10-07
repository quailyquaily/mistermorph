package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/caprefs"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/tools"
)

// skillInstallTools are console-only: the web console is where the user reads the preview and
// approves the install. Each is off by default (tools.<name>.enabled); like the built-in tools, a
// task that names one as $skill_install_preview or $skill_install gets it for that run, which is
// how the Skills page's Add skill works.
func (r *consoleLocalRuntime) skillInstallTools(generation *consoleLocalRuntimeGeneration, task string) []tools.Tool {
	if generation == nil || generation.bundle == nil || generation.bundle.taskRuntime == nil {
		return nil
	}
	reader := generation.reader
	refs := skillInstallToolRefs(task, skillsutil.ResolveTaskSkillRefs(task, skillsutil.SkillsConfigFromReader(reader)))
	// The install tools have no setting: only a task that names them, such as Add skill's, gets them.
	wants := func(name string) bool { return refs[name] }
	if !wants(skillinstall.PreviewToolName) && !wants(skillinstall.InstallToolName) {
		return nil
	}
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
	var out []tools.Tool
	if wants(preview.Name()) {
		out = append(out, preview)
	}
	if wants(install.Name()) {
		out = append(out, install)
	}
	return out
}

// skillInstallOnlyTask reports whether a task names the install tools ($skill_install_preview or
// $skill_install), as Add skill's task does. Such a task runs with only those tools (see
// restrictToSkillInstallTools): while a skill is previewed and installed the agent cannot run
// commands, write files, fetch URLs or start subtasks, so it cannot install the skill around the
// preview and the approval, and the skill's untrusted text cannot steer it into doing so.
func skillInstallOnlyTask(generation *consoleLocalRuntimeGeneration, task string) bool {
	if generation == nil {
		return false
	}
	consumed := skillsutil.ResolveTaskSkillRefs(task, skillsutil.SkillsConfigFromReader(generation.reader))
	return len(skillInstallToolRefs(task, consumed)) > 0
}

// restrictToSkillInstallTools keeps only the install tools and the given harmless extras.
func restrictToSkillInstallTools(reg *tools.Registry, extras ...string) *tools.Registry {
	keep := map[string]bool{skillinstall.PreviewToolName: true, skillinstall.InstallToolName: true}
	for _, name := range extras {
		keep[name] = true
	}
	out := tools.NewRegistry()
	for _, tool := range reg.All() {
		if keep[tool.Name()] {
			_ = out.Register(tool)
		}
	}
	return out
}

// skillInstallToolRefs finds $skill_install_preview and $skill_install in a task, skipping names
// that a skill of the same name already took (as toolsutil.ExplicitBuiltinToolRefs does).
func skillInstallToolRefs(task string, consumed map[string]bool) map[string]bool {
	out := map[string]bool{}
	for _, name := range caprefs.Names(task) {
		name = strings.ToLower(strings.TrimSpace(name))
		if consumed[name] {
			continue
		}
		if name == skillinstall.PreviewToolName || name == skillinstall.InstallToolName {
			out[name] = true
		}
	}
	return out
}

// enableInstalledSkill switches a new skill on through the settings file, like the Skills page.
func (r *consoleLocalRuntime) enableInstalledSkill(ctx context.Context, skillID string) error {
	fn := r.skillEnabler
	if fn == nil {
		return errors.New("settings are not writable here")
	}
	return fn(ctx, skillID)
}

// withSkillInstallPreview attaches, to a skill_install approval, the preview that call would
// install, so the approval card lists every risk before the user approves. Approving is what
// installs the skill.
func withSkillInstallPreview(info daemonruntime.ApprovalInfo) daemonruntime.ApprovalInfo {
	if !strings.EqualFold(strings.TrimSpace(info.ToolName), skillinstall.InstallToolName) {
		return info
	}
	id, _ := info.ToolParams["preview_id"].(string)
	preview, ok := skillinstall.DefaultService().LookupPreview(id)
	if !ok {
		return info
	}
	data, err := json.Marshal(preview)
	if err != nil {
		return info
	}
	info.SkillPreview = data
	return info
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
