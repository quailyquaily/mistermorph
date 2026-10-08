package agent

import (
	"context"
	"encoding/json"
	"strings"
)

const listModelProfilesToolName = "list_model_profiles"

// ModelProfile is one model profile a subtask can select with spawn's model_profile.
type ModelProfile struct {
	Name        string
	Model       string
	Description string
	// Current marks the profile the parent task is running on.
	Current bool
	// Error says why the profile could not be resolved; Model and Description are then empty.
	Error string
}

// ModelProfileLister lists the profiles a subtask can select. Its error is for config that cannot
// be read as a whole; a single broken profile is reported in its entry's Error.
type ModelProfileLister func(ctx context.Context) ([]ModelProfile, error)

const subtaskDelegationPromptBlock = `[[ Subtasks ]]
- If a self-contained subtask is expected to produce a lot of intermediate content (searching and filtering web pages, reading a long log, inspecting many files) and the main task only needs a small conclusion from it, consider ` + "`spawn`" + `. Whether the content deserves a place in your context matters more than how long the task is. Do simple tasks directly.
- The sub-agent does not see this conversation: put the background it needs, a clear goal and what to return in ` + "`task`" + `.
- Ask for a concise conclusion with the evidence needed to check it (source links, file locations, key excerpts), not the full raw content.`

const modelProfilesPromptBlock = `[[ Subtask Model Profiles ]]
- To run a subtask on a different model configuration, call ` + "`list_model_profiles`" + ` and pass the chosen name as spawn's ` + "`model_profile`" + `. Omit ` + "`model_profile`" + ` to use the current model.
- If this conversation already has a ` + "`list_model_profiles`" + ` result, reuse it instead of calling the tool before every spawn.`

type listModelProfilesTool struct {
	list ModelProfileLister
}

func newListModelProfilesTool(list ModelProfileLister) *listModelProfilesTool {
	return &listModelProfilesTool{list: list}
}

func (t *listModelProfilesTool) Name() string { return listModelProfilesToolName }

func (t *listModelProfilesTool) Description() string {
	return "List the model profiles a spawn subtask can run on, with each profile's model and description. " +
		"Pass a profile name as spawn's model_profile. `current` marks the profile you are running on. " +
		"A profile with `error` cannot be used until its configuration is fixed."
}

func (t *listModelProfilesTool) ParameterSchema() string {
	return `{"type":"object","properties":{}}`
}

type modelProfileEntry struct {
	Name        string `json:"name"`
	Model       string `json:"model"`
	Description string `json:"description"`
	Current     bool   `json:"current,omitempty"`
	Error       string `json:"error,omitempty"`
}

func (t *listModelProfilesTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	var profiles []ModelProfile
	if t.list != nil {
		var err error
		if profiles, err = t.list(ctx); err != nil {
			return "", err
		}
	}
	entries := make([]modelProfileEntry, 0, len(profiles))
	for _, profile := range profiles {
		entries = append(entries, modelProfileEntry{
			Name:        strings.TrimSpace(profile.Name),
			Model:       strings.TrimSpace(profile.Model),
			Description: strings.TrimSpace(profile.Description),
			Current:     profile.Current,
			Error:       strings.TrimSpace(profile.Error),
		})
	}
	b, err := json.Marshal(map[string]any{"profiles": entries})
	if err != nil {
		return "", err
	}
	return string(b), nil
}
