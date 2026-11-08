package configcmd

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/spf13/viper"
)

func useConfig(t *testing.T, path string) {
	t.Helper()
	previous, had := viper.Get("config"), viper.IsSet("config")
	viper.Set("config", path)
	t.Cleanup(func() {
		if had {
			viper.Set("config", previous)
		} else {
			viper.Set("config", nil)
		}
	})
}

// `morph config set file_state_dir` on the config in agent.db is refused with the reason, and the
// config is left as it was; other values still save.
func TestSetFileStateDirInAgentDBIsRefused(t *testing.T) {
	state := t.TempDir()
	path := configstore.DBConfigPath(state)
	useConfig(t, path)

	set := newSetCmd()
	set.SetArgs([]string{"logging.level", "warn"})
	if err := set.Execute(); err != nil {
		t.Fatalf("set logging.level: %v", err)
	}

	set = newSetCmd()
	set.SetArgs([]string{"file_state_dir", filepath.Join(t.TempDir(), "elsewhere")})
	err := set.Execute()
	var bootstrap *configstore.BootstrapKeyError
	if !errors.As(err, &bootstrap) {
		t.Fatalf("set file_state_dir err = %v, want a BootstrapKeyError", err)
	}
	out, err := configstore.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "file_state_dir") || !strings.Contains(string(out), "level: warn") {
		t.Fatalf("config =\n%s", out)
	}
}
