package configcmd

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
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

func runSet(args ...string) error {
	set := newSetCmd()
	set.SetArgs(args)
	set.SilenceUsage, set.SilenceErrors = true, true
	return set.Execute()
}

func savedUserName(t *testing.T, path string) (string, string) {
	t.Helper()
	raw, err := configstore.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Console struct {
			UserName string `yaml:"user_name"`
			Listen   string `yaml:"listen"`
		} `yaml:"console"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Console.UserName, string(raw)
}

// `morph config set console.user_name` saves the name by the rule the Console's Setup page and
// its API save it by; a value that is not a name is refused and the saved one stays. Other keys
// are set as before.
func TestSetConsoleUserNameIsCheckedLikeTheConsole(t *testing.T) {
	for kind, path := range map[string]string{
		"agent.db": configstore.DBConfigPath(t.TempDir()),
		"file":     filepath.Join(t.TempDir(), "config.yaml"),
	} {
		t.Run(kind, func(t *testing.T) {
			useConfig(t, path)
			if err := runSet("console.listen", "127.0.0.1:9191"); err != nil {
				t.Fatal(err)
			}
			for in, want := range map[string]string{
				"Lyra":                              "Lyra",
				`"  Ada  Lovelace  "`:               "Ada  Lovelace",
				`"\u3000小明 🙂\u00a0"`:                "小明 🙂",
				`"<b>x</b>"`:                        "<b>x</b>",
				"12":                                "12",
				`"` + strings.Repeat("名", 80) + `"`: strings.Repeat("名", 80),
			} {
				if err := runSet("console.user_name", in); err != nil {
					t.Fatalf("set %s: %v", in, err)
				}
				if got, raw := savedUserName(t, path); got != want {
					t.Fatalf("set %s saved %q, want %q:\n%s", in, got, want, raw)
				}
			}
			if err := runSet("console.user_name", "Prior"); err != nil {
				t.Fatal(err)
			}
			_, before := savedUserName(t, path)
			for in, want := range map[string]string{
				`""`:                                "must not be empty",
				`"   "`:                             "must not be empty",
				`"\u3000\u2003"`:                    "must not be empty",
				`"a\nb"`:                            "one line",
				`"a\tb"`:                            "control",
				`"` + strings.Repeat("名", 81) + `"`: "at most 80",
				"[a, b]":                            "must be text",
				"{name: a}":                         "must be text",
			} {
				err := runSet("console.user_name", in)
				if err == nil || !strings.Contains(err.Error(), "console.user_name") || !strings.Contains(err.Error(), want) {
					t.Fatalf("set %s err = %v, want one naming the key with %q", in, err, want)
				}
				if got, raw := savedUserName(t, path); got != "Prior" || raw != before {
					t.Fatalf("a refused set %s changed the config:\n%s", in, raw)
				}
			}
			// Inside a larger value it is checked too.
			if err := runSet("console", `{listen: "127.0.0.1:1", user_name: "a\nb"}`); err == nil || !strings.Contains(err.Error(), "one line") {
				t.Fatalf("set console with a bad name err = %v", err)
			}
			if _, raw := savedUserName(t, path); raw != before {
				t.Fatalf("a refused set of console changed the config:\n%s", raw)
			}
			// Unrelated keys take any text, and removing the name is --unset.
			if err := runSet("llm.model", `"  spaced  "`); err != nil {
				t.Fatal(err)
			}
			if err := runSet("console.user_name", "--unset"); err != nil {
				t.Fatal(err)
			}
			raw, _ := configstore.ReadFile(path)
			if strings.Contains(string(raw), "user_name") || !strings.Contains(string(raw), "  spaced  ") || !strings.Contains(string(raw), "127.0.0.1:9191") {
				t.Fatalf("config =\n%s", raw)
			}
		})
	}
}

// A whole config (config import, config edit) with a name that is not one is not saved; a valid
// name is saved trimmed, and an empty one (the template's) means none.
func TestImportChecksConsoleUserName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	const prior = "console:\n  listen: 127.0.0.1:9191\n  user_name: Prior\n"
	if err := ImportDocument(path, []byte(prior)); err != nil {
		t.Fatal(err)
	}
	for name, doc := range map[string]string{
		"line break": "console:\n  user_name: \"a\\nb\"\n",
		"too long":   "console:\n  user_name: " + strings.Repeat("x", 81) + "\n",
		"spaces":     "console:\n  user_name: \"   \"\n",
		"a list":     "console:\n  user_name: [a]\n",
	} {
		err := ImportDocument(path, []byte(doc))
		if err == nil || !strings.Contains(err.Error(), "console.user_name") {
			t.Fatalf("%s: import err = %v, want a refusal naming the key", name, err)
		}
		if raw, _ := configstore.ReadFile(path); string(raw) != prior {
			t.Fatalf("%s: a refused import changed the config:\n%s", name, raw)
		}
	}
	if err := ImportDocument(path, []byte("# mine\nllm:\n  model: m\nconsole:\n  user_name: \"  小明  \"\n")); err != nil {
		t.Fatal(err)
	}
	if got, raw := savedUserName(t, path); got != "小明" || !strings.Contains(raw, "model: m") {
		t.Fatalf("imported config =\n%s", raw)
	}
	// Untouched when there is nothing to change: the bytes given are the bytes saved.
	for _, doc := range []string{
		"# keep me\nconsole:\n  user_name: Lyra # hers\n",
		"console:\n  user_name: \"\"\n",
		"# no console\nllm:\n  model: m\n",
	} {
		if err := ImportDocument(path, []byte(doc)); err != nil {
			t.Fatalf("import %q: %v", doc, err)
		}
		if raw, _ := configstore.ReadFile(path); string(raw) != doc {
			t.Fatalf("import rewrote the config:\n%s\nwant\n%s", raw, doc)
		}
	}
}

func TestEditRefusesAnInvalidConsoleUserName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	useConfig(t, path)
	const prior = "console:\n  user_name: Prior\n"
	if err := ImportDocument(path, []byte(prior)); err != nil {
		t.Fatal(err)
	}
	previous := editorCommand
	t.Cleanup(func() { editorCommand = previous })
	editorCommand = func(file string) error {
		return os.WriteFile(file, []byte("console:\n  user_name: \"a\\nb\"\n"), 0o600)
	}
	edit := newEditCmd()
	edit.SetArgs(nil)
	edit.SilenceUsage, edit.SilenceErrors = true, true
	if err := edit.Execute(); err == nil || !strings.Contains(err.Error(), "console.user_name") {
		t.Fatalf("edit err = %v, want a refusal naming the key", err)
	}
	if raw, _ := configstore.ReadFile(path); string(raw) != prior {
		t.Fatalf("a refused edit changed the config:\n%s", raw)
	}
}
