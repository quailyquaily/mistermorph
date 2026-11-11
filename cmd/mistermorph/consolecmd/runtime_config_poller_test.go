package consolecmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configstore"
)

func TestRuntimeConfigPollerWaitsForActiveReloadAfterCancel(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	reloadStarted := make(chan struct{})
	releaseReload := make(chan struct{})
	srv := &server{
		cfg: serveConfig{configPath: configPath},
		reloadRuntimeConfigFunc: func() error {
			close(reloadStarted)
			<-releaseReload
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv.startRuntimeConfigPoller(ctx)
	if err := os.WriteFile(configPath, []byte("llm:\n  model: changed\n"), 0o600); err != nil {
		t.Fatalf("WriteFile(config) error = %v", err)
	}

	select {
	case <-reloadStarted:
	case <-time.After(2 * consoleConfigPollInterval):
		t.Fatal("runtime config reload did not start")
	}
	cancel()
	pollerDone := make(chan struct{})
	go func() {
		srv.runtimeConfigPollerWG.Wait()
		close(pollerDone)
	}()
	select {
	case <-pollerDone:
		t.Fatal("config poller exited before the active reload returned")
	case <-time.After(20 * time.Millisecond):
	}

	close(releaseReload)
	select {
	case <-pollerDone:
	case <-time.After(time.Second):
		t.Fatal("config poller did not exit after the active reload returned")
	}
}

// Since the config moved into agent.db its path names no file, so a poller that looked at the
// file's time never saw a save and the Console kept the models it started with.
func TestRuntimeConfigPollerReloadsAfterAnAgentDBSave(t *testing.T) {
	configPath := configstore.DBConfigPath(t.TempDir())
	if err := configstore.WriteFileBy(configPath, []byte("llm:\n  model: before\n"), configstore.ByConsole); err != nil {
		t.Fatalf("WriteFileBy(before) error = %v", err)
	}
	reloaded := make(chan struct{}, 4)
	srv := &server{
		cfg: serveConfig{configPath: configPath},
		reloadRuntimeConfigFunc: func() error {
			reloaded <- struct{}{}
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		srv.runtimeConfigPollerWG.Wait()
	}()
	srv.startRuntimeConfigPoller(ctx)

	select {
	case <-reloaded:
		t.Fatal("reloaded with no save")
	case <-time.After(consoleConfigPollInterval + 200*time.Millisecond):
	}
	if err := configstore.WriteFileBy(configPath, []byte("llm:\n  model: after\n"), configstore.ByConsole); err != nil {
		t.Fatalf("WriteFileBy(after) error = %v", err)
	}
	select {
	case <-reloaded:
	case <-time.After(3 * consoleConfigPollInterval):
		t.Fatal("runtime config did not reload after an agent.db save")
	}
}
