package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/topicstate"
)

func TestParseCommandArgs(t *testing.T) {
	cases := []struct {
		name    string
		args    string
		want    Command
		wantErr string
	}{
		{
			name: "status",
			args: "",
			want: Command{Action: CommandStatus},
		},
		{
			name: "attach",
			args: "attach ./repo",
			want: Command{Action: CommandAttach, Dir: "./repo"},
		},
		{
			name: "detach",
			args: "detach",
			want: Command{Action: CommandDetach},
		},
		{
			name:    "detach extra args",
			args:    "detach now",
			wantErr: "usage: /workspace | /workspace attach <dir> | /workspace detach",
		},
		{
			name:    "unknown",
			args:    "list",
			wantErr: "usage: /workspace | /workspace attach <dir> | /workspace detach",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseCommandArgs(tc.args)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if err.Error() != tc.wantErr {
					t.Fatalf("error = %q, want %q", err.Error(), tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestExecuteStoreCommandLifecycle(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "workspace_attachments.json"))
	scopeKey := "line:Cgroup123"
	dirA := t.TempDir()
	dirB := t.TempDir()

	result, err := ExecuteStoreCommand(store, scopeKey, "", dirA, nil)
	if err != nil {
		t.Fatalf("status error: %v", err)
	}
	if result.Reply != "workspace: "+dirA+" (default)" {
		t.Fatalf("status reply = %q", result.Reply)
	}

	result, err = ExecuteStoreCommand(store, scopeKey, "attach "+dirB, dirA, nil)
	if err != nil {
		t.Fatalf("attach error: %v", err)
	}
	if result.Reply != "workspace attached: "+dirB {
		t.Fatalf("attach reply = %q", result.Reply)
	}
	if result.WorkspaceDir != dirB {
		t.Fatalf("workspace result = %#v, want attachment %q", result, dirB)
	}

	currentDir, err := LookupWorkspaceDir(store, scopeKey)
	if err != nil {
		t.Fatalf("lookup error: %v", err)
	}
	if currentDir != dirB {
		t.Fatalf("lookup = %q, want %q", currentDir, dirB)
	}

	result, err = ExecuteStoreCommand(store, scopeKey, "detach", dirA, nil)
	if err != nil {
		t.Fatalf("detach error: %v", err)
	}
	if result.Reply != "workspace detached: "+dirB+"\nworkspace: "+dirA+" (default)" {
		t.Fatalf("detach reply = %q", result.Reply)
	}
	if result.WorkspaceDir != dirA {
		t.Fatalf("detach result = %#v, want default %q", result, dirA)
	}

	currentDir, err = LookupWorkspaceDir(store, scopeKey)
	if err != nil {
		t.Fatalf("lookup after detach error: %v", err)
	}
	if currentDir != "" {
		t.Fatalf("lookup after detach = %q, want empty", currentDir)
	}

	result, err = ExecuteStoreCommand(store, scopeKey, "detach", dirA, nil)
	if err != nil {
		t.Fatalf("detach default error: %v", err)
	}
	if result.Reply != "workspace: "+dirA+" (default); no attachment to detach" {
		t.Fatalf("detach default reply = %q", result.Reply)
	}
}

func TestResolveUsesAttachmentThenDefault(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "workspace_attachments.json"))
	scopeKey := "console:topic-a"
	defaultDir := t.TempDir()
	attachedDir := t.TempDir()

	resolved, err := Resolve(store, scopeKey, defaultDir)
	if err != nil {
		t.Fatalf("Resolve(default) error = %v", err)
	}
	if resolved.WorkspaceDir != defaultDir || resolved.Source != SourceDefault {
		t.Fatalf("Resolve(default) = %#v", resolved)
	}
	if _, ok, err := store.Get(scopeKey); err != nil || ok {
		t.Fatalf("default created attachment: ok=%v err=%v", ok, err)
	}

	if _, _, err := store.Set(scopeKey, Attachment{WorkspaceDir: attachedDir}); err != nil {
		t.Fatalf("store.Set() error = %v", err)
	}
	resolved, err = Resolve(store, scopeKey, defaultDir)
	if err != nil {
		t.Fatalf("Resolve(attachment) error = %v", err)
	}
	if resolved.WorkspaceDir != attachedDir || resolved.Source != SourceAttachment {
		t.Fatalf("Resolve(attachment) = %#v", resolved)
	}
}

func TestResolveReturnsNoneWithoutAttachmentOrDefault(t *testing.T) {
	resolved, err := Resolve(nil, "console:topic-a", "")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.WorkspaceDir != "" || resolved.Source != SourceNone {
		t.Fatalf("Resolve() = %#v", resolved)
	}
}

func TestResolveInitialWorkspacePriority(t *testing.T) {
	cwd := t.TempDir()
	defaultDir := t.TempDir()
	explicitDir := t.TempDir()

	tests := []struct {
		name       string
		raw        string
		disabled   bool
		defaultDir string
		want       string
	}{
		{name: "disabled", raw: explicitDir, disabled: true, defaultDir: defaultDir, want: ""},
		{name: "explicit", raw: explicitDir, defaultDir: defaultDir, want: explicitDir},
		{name: "configured default", defaultDir: defaultDir, want: defaultDir},
		{name: "cwd fallback", want: cwd},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveInitialWorkspace(cwd, tc.raw, tc.disabled, tc.defaultDir, nil)
			if err != nil {
				t.Fatalf("ResolveInitialWorkspace() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("ResolveInitialWorkspace() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidateDir_RejectsOutsideAllowedRoots(t *testing.T) {
	allowedRoot := t.TempDir()
	outsideRoot := t.TempDir()

	_, err := ValidateDir(outsideRoot, []string{allowedRoot})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "outside allowed roots") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStoreImportsTheLegacyFileAndTopicFolders(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "workspace_attachments.json")
	raw := `{"version":1,"attachments":{"console:a":{"workspace_dir":"/srv/a"},"console:b":{"workspace_dir":"/srv/b"}}}`
	if err := os.WriteFile(legacy, []byte(raw), 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}
	// A folder whose workspace.json is the only file: nothing in it names the key, so it is
	// imported the first time its scope is asked for.
	lone := filepath.Join(root, "topics", topicstate.Key("console:c"))
	if err := os.MkdirAll(lone, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lone, "workspace.json"), []byte(`{"workspace_dir":"/srv/c"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(legacy)
	for key, want := range map[string]string{"console:a": "/srv/a", "console:b": "/srv/b", "console:c": "/srv/c"} {
		got, ok, err := store.Get(key)
		if err != nil || !ok || got.WorkspaceDir != want {
			t.Fatalf("Get(%q) = %+v ok=%v err=%v", key, got, ok, err)
		}
	}
	if _, err := os.Stat(legacy + ".imported"); err != nil {
		t.Fatalf("legacy file not renamed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(lone, "workspace.json.imported")); err != nil {
		t.Fatalf("folder file not renamed: %v", err)
	}
	if prev, had, err := store.Delete("console:a"); err != nil || !had || prev.WorkspaceDir != "/srv/a" {
		t.Fatalf("Delete() = %+v had=%v err=%v", prev, had, err)
	}
	if _, ok, _ := store.Get("console:a"); ok {
		t.Fatal("attachment left after Delete")
	}
	if prev, had, err := store.Set("console:b", Attachment{WorkspaceDir: "/srv/b2"}); err != nil || !had || prev.WorkspaceDir != "/srv/b" {
		t.Fatalf("Set() = %+v had=%v err=%v", prev, had, err)
	}
	if got, _, _ := NewStore(legacy).Get("console:b"); got.WorkspaceDir != "/srv/b2" {
		t.Fatalf("after Set = %+v", got)
	}
}
