package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/pricingutil"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/viper"
)

// ~/.morph/config.yaml imported into agent.db keeps pointing its relative file settings at the
// files beside it, whichever way the state folder was settled.
func TestConfigImportKeepsRelativeFileTargets(t *testing.T) {
	cases := []struct {
		name string
		// state returns the state folder and the lines config.yaml starts with.
		state func(t *testing.T, morph string) (string, string)
	}{
		{"state folder from the environment", func(t *testing.T, _ string) (string, string) {
			state := t.TempDir()
			t.Setenv("MISTER_MORPH_FILE_STATE_DIR", state)
			return state, ""
		}},
		{"state folder from file_state_dir in the old config", func(t *testing.T, _ string) (string, string) {
			state := t.TempDir()
			return state, "file_state_dir: " + state + "\n"
		}},
		{"state folder is the config's folder", func(t *testing.T, morph string) (string, string) {
			return morph, ""
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRootConfigForTest(t)
			morph := filepath.Join(os.Getenv("HOME"), ".morph")
			if err := os.MkdirAll(filepath.Join(morph, "credentials"), 0o700); err != nil {
				t.Fatal(err)
			}
			state, head := tc.state(t, morph)
			t.Cleanup(func() { _ = agentdb.CachedStateDir(state).Close() })
			keystore := filepath.Join(morph, "credentials", "mixin.json")
			if err := os.WriteFile(keystore, []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
			pricing := []byte("chat:\n  - inference_provider: openai\n    model: ft36-model\n    input_usd_per_million: 1\n    output_usd_per_million: 2\n")
			if err := os.WriteFile(filepath.Join(morph, "pricing.yaml"), pricing, 0o600); err != nil {
				t.Fatal(err)
			}
			config := head + "llm:\n  pricing_file: ./pricing.yaml\nmixin:\n  keystore_file: credentials/mixin.json\n"
			if err := os.WriteFile(filepath.Join(morph, "config.yaml"), []byte(config), 0o600); err != nil {
				t.Fatal(err)
			}

			for start := 1; start <= 2; start++ {
				viper.Reset()
				if err := loadRootConfig(nil); err != nil {
					t.Fatalf("start %d: %v", start, err)
				}
				if got := viper.GetString("file_state_dir"); got != state {
					t.Fatalf("start %d: state folder = %q, want %q", start, got, state)
				}
				cfg, err := toolsutil.StaticRegistryConfigFromReader(viper.GetViper())
				if err != nil {
					t.Fatal(err)
				}
				if got := cfg.ContactsSend.MixinKeystoreFile; got != keystore {
					t.Fatalf("start %d: mixin keystore = %q, want %q", start, got, keystore)
				}
				_, digest, err := pricingutil.LoadCatalog(viper.GetString("llm.pricing_file"), viper.GetString("config"))
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(pricing)
				if digest != hex.EncodeToString(sum[:]) {
					t.Fatalf("start %d: llm.pricing_file %q from config %q does not load ~/.morph/pricing.yaml", start,
						viper.GetString("llm.pricing_file"), viper.GetString("config"))
				}
			}
			if _, err := os.Stat(filepath.Join(morph, "config.yaml.imported")); err != nil {
				t.Fatalf("config.yaml not imported: %v", err)
			}
		})
	}
}
