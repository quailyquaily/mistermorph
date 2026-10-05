package configutil

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func TestReadExpandedConfigWarnsAboutRemovedImageModelKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("llm:\n  model: gpt-5.5\n  image:\n    provider: openai\n    model: gpt-image-2\n    request_timeout: 90s\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var warnings []string
	v := viper.New()
	if err := ReadExpandedConfig(v, path, func(format string, args ...any) {
		warnings = append(warnings, fmt.Sprintf(format, args...))
	}); err != nil {
		t.Fatalf("ReadExpandedConfig() error = %v", err)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %q, want one", warnings)
	}
	for _, want := range []string{"llm.image.provider", "llm.image.model", "llm.routes.image"} {
		if !strings.Contains(warnings[0], want) {
			t.Fatalf("warning %q does not mention %s", warnings[0], want)
		}
	}
	if strings.Contains(warnings[0], "request_timeout") {
		t.Fatalf("warning %q names llm.image.request_timeout, which is still used", warnings[0])
	}
}

func TestReadExpandedConfigDoesNotWarnWithoutRemovedKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("llm:\n  model: gpt-5.5\n  image:\n    request_timeout: 90s\n  routes:\n    image: painter\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	warned := false
	if err := ReadExpandedConfig(viper.New(), path, func(string, ...any) { warned = true }); err != nil {
		t.Fatalf("ReadExpandedConfig() error = %v", err)
	}
	if warned {
		t.Fatal("warned for a config without removed keys")
	}
}
