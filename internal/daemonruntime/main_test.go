package daemonruntime

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestMain fails the package when a test leaves a state database in the package folder: every
// test's state belongs in a t.TempDir(), and an empty state folder must not fall back to the
// working directory.
func TestMain(m *testing.M) {
	code := m.Run()
	if leaked := leakedStateDatabases(); len(leaked) > 0 {
		fmt.Fprintf(os.Stderr, "tests left state databases in the package folder: %v\n", leaked)
		for _, p := range leaked {
			_ = os.Remove(p)
		}
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}

func leakedStateDatabases() []string {
	var leaked []string
	for _, pattern := range []string{"agent.db*", "usage.db*", "memory.db*"} {
		matches, _ := filepath.Glob(pattern)
		leaked = append(leaked, matches...)
	}
	return leaked
}
