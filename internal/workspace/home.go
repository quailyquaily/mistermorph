package workspace

import (
	"os"
	"path/filepath"
	"strings"
)

// HostHomeDir is the home directory of the user this process runs as: the host that resolves,
// lists and opens workspace paths. Clients show workspace paths under it with `~`; it is "" when
// the system cannot tell, and then they show paths in full.
func HostHomeDir() string {
	return cleanHomeDir(os.UserHomeDir())
}

func cleanHomeDir(home string, err error) string {
	home = strings.TrimSpace(home)
	if err != nil || home == "" || !filepath.IsAbs(home) {
		return ""
	}
	return filepath.Clean(home)
}
