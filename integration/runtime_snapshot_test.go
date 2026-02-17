package integration

import (
	"testing"
	"time"

	"github.com/spf13/viper"
)

func TestRuntimeSnapshotFreezesRequestTimeout(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	cfg := DefaultConfig()
	cfg.Set("llm.request_timeout", 5*time.Second)

	rt := New(cfg)

	if got := rt.RequestTimeout(); got != 5*time.Second {
		t.Fatalf("RequestTimeout() = %v, want %v", got, 5*time.Second)
	}

	viper.Set("llm.request_timeout", 99*time.Second)
	if got := rt.RequestTimeout(); got != 5*time.Second {
		t.Fatalf("RequestTimeout() changed after viper mutation: got %v, want %v", got, 5*time.Second)
	}
}

func TestRuntimeSnapshotFreezesRegistryToolConfig(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	cfg := DefaultConfig()
	cfg.Set("tools.write_file.enabled", false)

	rt := New(cfg)

	reg := rt.NewRegistry()
	if _, ok := reg.Get("write_file"); ok {
		t.Fatalf("write_file should be disabled by snapshot config")
	}

	viper.Set("tools.write_file.enabled", true)
	reg = rt.NewRegistry()
	if _, ok := reg.Get("write_file"); ok {
		t.Fatalf("write_file should remain disabled after viper mutation")
	}
}

func TestRuntimeSnapshotIgnoresGlobalViper(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	viper.Set("llm.request_timeout", 77*time.Second)

	rt := New(DefaultConfig())
	if got := rt.RequestTimeout(); got != 90*time.Second {
		t.Fatalf("RequestTimeout() = %v, want %v", got, 90*time.Second)
	}
}
