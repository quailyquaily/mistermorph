package workspace

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestCleanHomeDir(t *testing.T) {
	abs := filepath.Join(string(filepath.Separator)+"home", "morph")
	tests := []struct {
		name string
		home string
		err  error
		want string
	}{
		{name: "absolute", home: abs, want: abs},
		{name: "trailing separator", home: abs + string(filepath.Separator), want: abs},
		{name: "surrounding spaces", home: "  " + abs + "  ", want: abs},
		{name: "empty", home: "", want: ""},
		{name: "relative", home: "morph", want: ""},
		{name: "lookup error", home: abs, err: errors.New("no home"), want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanHomeDir(tt.home, tt.err); got != tt.want {
				t.Fatalf("cleanHomeDir(%q, %v) = %q, want %q", tt.home, tt.err, got, tt.want)
			}
		})
	}
}

func TestHostHomeDirFollowsHOME(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if got := HostHomeDir(); got != filepath.Clean(home) {
		t.Fatalf("HostHomeDir() = %q, want %q", got, filepath.Clean(home))
	}
}
