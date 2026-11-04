package testenv

import (
	"os"
	"testing"
)

func TestClearAppEnv(t *testing.T) {
	t.Setenv("MISTER_MORPH_LLM_PROVIDER", "openai")
	t.Setenv("MISTER_MORPH_", "empty suffix")
	t.Setenv("MISTER_MORPHX", "kept")
	t.Setenv("OTHER_MISTER_MORPH_KEY", "kept")
	ClearAppEnv()
	for _, name := range []string{"MISTER_MORPH_LLM_PROVIDER", "MISTER_MORPH_"} {
		if value, ok := os.LookupEnv(name); ok {
			t.Errorf("%s = %q, want unset", name, value)
		}
	}
	for _, name := range []string{"MISTER_MORPHX", "OTHER_MISTER_MORPH_KEY"} {
		if os.Getenv(name) != "kept" {
			t.Errorf("%s was cleared", name)
		}
	}
}
