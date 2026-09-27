package consolecmd

import (
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

func TestSkillInstallToolsAreConsoleOnly(t *testing.T) {
	stateDir := t.TempDir()
	reader := viper.New()
	reader.Set("file_state_dir", stateDir)
	reader.Set("skills.store.index_url", "https://example.test/index.json")
	gen := &consoleLocalRuntimeGeneration{
		reader: reader,
		paths:  runtimepaths.Paths{StateDir: stateDir},
		bundle: &consoleLocalRuntimeBundle{taskRuntime: &taskruntime.Runtime{}},
	}
	rt := &consoleLocalRuntime{}
	names := func(task string) string {
		var out []string
		for _, tool := range rt.skillInstallTools(gen, task) {
			out = append(out, tool.Name())
		}
		return strings.Join(out, ",")
	}
	// Off by default; a task that names a tool with $ gets it for that run.
	for _, tc := range []struct {
		name, task, want string
	}{
		{name: "off by default", task: "install the skill at https://example.test", want: ""},
		{name: "plain words do not count", task: "call skill_install_preview then skill_install", want: ""},
		{name: "both named", task: "Preview it with $skill_install_preview, then call $skill_install.", want: "skill_install_preview,skill_install"},
		{name: "one named", task: "use $skill_install_preview only", want: "skill_install_preview"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := names(tc.task); got != tc.want {
				t.Fatalf("tools = %q, want %q", got, tc.want)
			}
		})
	}
	reader.Set("tools.skill_install_preview.enabled", true)
	if got := names("anything"); got != "skill_install_preview" {
		t.Fatalf("enabled in config: tools = %q", got)
	}
	reader.Set("tools.skill_install.enabled", true)
	if got := names("anything"); got != "skill_install_preview,skill_install" {
		t.Fatalf("both enabled in config: tools = %q", got)
	}
	if rt.skillInstallTools(nil, "$skill_install") != nil {
		t.Fatal("expected no tools without a generation")
	}
	if err := rt.enableInstalledSkill(context.Background(), "pdf"); err == nil {
		t.Fatal("expected an error without a settings writer")
	}
	if got := skillStoreIndexURL(reader); got != "https://example.test/index.json" {
		t.Fatalf("index url = %q", got)
	}
	if got := skillStoreIndexURL(viper.New()); got != skillinstall.DefaultStoreIndexURL {
		t.Fatalf("default index url = %q", got)
	}
}

func TestWithSkillInstallPreviewOnlyTouchesSkillInstall(t *testing.T) {
	other := withSkillInstallPreview(daemonruntime.ApprovalInfo{ToolName: "bash", ToolParams: map[string]any{"preview_id": "x"}})
	if other.SkillPreview != nil {
		t.Fatalf("bash approval got a skill preview: %s", other.SkillPreview)
	}
	// An unknown or expired preview attaches nothing; the card then says the preview expired.
	missing := withSkillInstallPreview(daemonruntime.ApprovalInfo{ToolName: "skill_install", ToolParams: map[string]any{"preview_id": "nope"}})
	if missing.SkillPreview != nil {
		t.Fatalf("missing preview attached: %s", missing.SkillPreview)
	}
}

func TestSkillInstallTasksRunWithOnlyTheInstallTools(t *testing.T) {
	gen := &consoleLocalRuntimeGeneration{reader: viper.New()}
	for task, want := range map[string]bool{
		"Install the skill at https://x. Preview it with $skill_install_preview, then call $skill_install.": true,
		"just $skill_install":                        true,
		"install a skill with skill_install_preview": false,
		"run $bash please":                           false,
	} {
		if got := skillInstallOnlyTask(gen, task); got != want {
			t.Errorf("skillInstallOnlyTask(%q) = %v, want %v", task, got, want)
		}
	}
	if skillInstallOnlyTask(nil, "$skill_install") {
		t.Error("expected false without a generation")
	}

	reg := tools.NewRegistry()
	for _, name := range []string{"bash", "url_fetch", "write_file", "read_file", "web_search", "skill_install_preview", "skill_install", "message_react"} {
		_ = reg.Register(namedTool(name))
	}
	got := restrictToSkillInstallTools(reg, "message_react")
	var names []string
	for _, tool := range got.All() {
		names = append(names, tool.Name())
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "message_react,skill_install,skill_install_preview" {
		t.Fatalf("tools = %v", names)
	}
}

type namedTool string

func (n namedTool) Name() string                                            { return string(n) }
func (n namedTool) Description() string                                     { return "" }
func (n namedTool) ParameterSchema() string                                 { return `{"type":"object"}` }
func (n namedTool) Execute(context.Context, map[string]any) (string, error) { return "", nil }
