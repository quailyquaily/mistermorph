package chatcmd

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
)

type sharedSettings struct {
	LLM struct {
		Model    string `json:"model"`
		Provider string `json:"provider"`
	} `json:"llm"`
	Skills struct {
		Loaded    []skillsutil.SkillStatusItem `json:"loaded"`
		Available []skillsutil.SkillStatusItem `json:"available"`
	} `json:"skills"`
	ConfigValues struct {
		WorkspaceDir string `json:"workspace_dir"`
		FileStateDir string `json:"file_state_dir"`
		FileCacheDir string `json:"file_cache_dir"`
	} `json:"config_values"`
	err error
}

func (m *chatModel) loadSharedSettings() tea.Cmd {
	if m.skillsLoading {
		return nil
	}
	m.skillsLoading = true
	ctx, client := m.ctx, m.client
	return func() tea.Msg {
		var settings sharedSettings
		settings.err = client.request(ctx, "GET", "/settings/agent", nil, &settings)
		return settings
	}
}

func (m *chatModel) applySharedSettings(settings sharedSettings) {
	m.skillsLoading = false
	if settings.err != nil {
		m.skillsError = settings.err.Error()
		return
	}
	m.skillsError = ""
	m.settingsLoaded = true
	m.provider = remoteLine(settings.LLM.Provider)
	m.fileStateDir = remoteLine(settings.ConfigValues.FileStateDir)
	m.fileCacheDir = remoteLine(settings.ConfigValues.FileCacheDir)
	m.defaultModel = remoteLine(settings.LLM.Model)
	m.defaultWorkspace = remoteLine(settings.ConfigValues.WorkspaceDir)
	if m.id == "" || m.status.model == "" {
		m.status.model = m.defaultModel
	}
	if m.id == "" && m.draft().workspace == "" {
		m.status.workspace = m.defaultWorkspace
	}
	m.skillItems = nil
	seen := map[string]bool{}
	for _, item := range append(settings.Skills.Loaded, settings.Skills.Available...) {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = strings.TrimSpace(item.Name)
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		m.skillItems = append(m.skillItems, item)
	}
}
