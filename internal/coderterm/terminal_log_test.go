package coderterm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	vt "github.com/charmbracelet/x/vt"
)

// logScreens renders each terminal log under root, so a failure shows what the CLI displayed.
func logScreens(t *testing.T, root string) {
	t.Helper()
	logs, _ := filepath.Glob(filepath.Join(root, "coder", "*", "terminal.log"))
	for _, path := range logs {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		screen := vt.NewEmulator(120, 40)
		go func() {
			buf := make([]byte, 1024)
			for {
				if _, err := screen.Read(buf); err != nil {
					return
				}
			}
		}()
		_, _ = screen.Write(data)
		var lines []string
		for _, line := range strings.Split(screen.String(), "\n") {
			if line = strings.TrimRight(line, " "); line != "" {
				lines = append(lines, line)
			}
		}
		// The emulator stays open: closing it races with the reader above, and the test ends soon.
		t.Logf("screen of %s:\n%s", path, strings.Join(lines, "\n"))
	}
}
