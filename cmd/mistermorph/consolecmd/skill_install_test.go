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
	got := rt.skillInstallTools(gen)
	var names []string
	for _, tool := range got {
		names = append(names, tool.Name())
	}
	if strings.Join(names, ",") != "skill_install_preview,skill_install" {
		t.Fatalf("tools = %v", names)
	}
	if rt.skillInstallTools(nil) != nil {
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
