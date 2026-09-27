package skillinstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ToolDeps wire the install tools to the running agent. Options is resolved per call so config
// changes (skills folder, model) apply without a restart.
type ToolDeps struct {
	Service       *Service
	Store         *Store
	Options       func(ctx context.Context) (Options, error)
	StoreIndexURL func() string
}

// NewTools returns skill_install_preview and skill_install. Register them only where the user
// can see the conversation and approve (the web console); skill_install always needs approval.
func NewTools(deps ToolDeps) (*PreviewTool, *InstallTool) {
	return &PreviewTool{deps: deps}, &InstallTool{deps: deps}
}

// The tools' names, which are also their config keys: tools.<name>.enabled.
const (
	PreviewToolName = "skill_install_preview"
	InstallToolName = "skill_install"
)

type PreviewTool struct{ deps ToolDeps }

func (t *PreviewTool) Name() string { return PreviewToolName }

func (t *PreviewTool) Description() string {
	return "Preview a skill before installing it. Pass `link` (a GitHub repository, folder or SKILL.md link, or an https link to a SKILL.md) or `store_id` (a Morph Skill Store skill). " +
		"Downloads and pins the skill, runs a separate safety review, and returns what it does, its files, requirements and risks. Installs nothing. " +
		"Use it only when the user asks to install a skill. Then call skill_install with the returned values: its approval card shows the user this preview with every risk, and approving installs the skill. " +
		"If the preview fails, tell the user why and stop: never install the skill another way (git clone, bash, write_file), since that skips the user's approval."
}

func (t *PreviewTool) ParameterSchema() string {
	return `{"type":"object","properties":{"link":{"type":"string","description":"GitHub or https SKILL.md link to install from."},"store_id":{"type":"string","description":"Morph Skill Store skill id."}},"additionalProperties":false}`
}

func (t *PreviewTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	link := strings.TrimSpace(stringParam(params, "link"))
	storeID := strings.TrimSpace(stringParam(params, "store_id"))
	if (link == "") == (storeID == "") {
		return "", errors.New("pass exactly one of link or store_id")
	}
	opts, err := t.deps.Options(ctx)
	if err != nil {
		return "", err
	}
	var expect *Expectation
	if storeID != "" {
		url := ""
		if t.deps.StoreIndexURL != nil {
			url = t.deps.StoreIndexURL()
		}
		index, _, err := t.deps.Store.Index(ctx, url)
		if err != nil {
			return "", err
		}
		entry, ok := index.Find(storeID)
		if !ok {
			return "", fmt.Errorf("the skill store has no skill %q", storeID)
		}
		link = entry.Link(index.Repo)
		expect = entry.Expectation()
	}
	preview, err := t.deps.Service.Preview(ctx, opts, link, expect)
	var candidates errCandidates
	if errors.As(err, &candidates) {
		return "", fmt.Errorf("%s. Ask the user which one, then preview its folder link", candidates.Error())
	}
	if err != nil {
		return "", err
	}
	out := map[string]any{
		"preview": preview,
		"next_step": "Call skill_install now with preview_id, name, source (the source url) and commit exactly as given here" + replaceHint(preview) +
			". Its approval card shows the user this preview with every risk; approving installs the skill, denying cancels it. " +
			"Then tell the user the outcome. The preview expires at expires_at.",
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	return string(data), nil
}

func replaceHint(p Preview) string {
	if p.Conflict == nil {
		return ""
	}
	return ", and replace: true only if the user wants to overwrite the installed skill " + p.SkillID
}

type InstallTool struct{ deps ToolDeps }

func (t *InstallTool) Name() string { return InstallToolName }

func (t *InstallTool) Description() string {
	return "Install a skill previewed with skill_install_preview. Always asks the user to approve first. Pass the preview's preview_id, name, source (its source url) and commit exactly as returned; " +
		"set replace only when the user agreed to overwrite an installed skill. The skill is switched on after installing."
}

func (t *InstallTool) ParameterSchema() string {
	return `{"type":"object","properties":{"preview_id":{"type":"string"},"name":{"type":"string","description":"Skill name from the preview."},"source":{"type":"string","description":"Source url from the preview."},"commit":{"type":"string","description":"Commit from the preview (empty for plain links)."},"replace":{"type":"boolean"}},"required":["preview_id","name","source"],"additionalProperties":false}`
}

func (t *InstallTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	opts, err := t.deps.Options(ctx)
	if err != nil {
		return "", err
	}
	replace, _ := params["replace"].(bool)
	installed, err := t.deps.Service.Install(ctx, opts, InstallRequest{
		PreviewID: stringParam(params, "preview_id"),
		Name:      stringParam(params, "name"),
		SourceURL: stringParam(params, "source"),
		Commit:    stringParam(params, "commit"),
		Replace:   replace,
	})
	if err != nil {
		return "", err
	}
	data, _ := json.MarshalIndent(map[string]any{
		"installed": installed,
		"note":      "Installed and switched on. It is available from the next task.",
	}, "", "  ")
	return string(data), nil
}

func stringParam(params map[string]any, key string) string {
	v, _ := params[key].(string)
	return strings.TrimSpace(v)
}
