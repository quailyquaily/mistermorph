package consolecmd

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/skillinstall"
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
