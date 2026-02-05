package memory

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	shortTermIndexName = "_index.md"
	longTermDirName    = "_longterms"
)

func NewManager(dir string, shortTermDays int) *Manager {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = "memory"
	}
	dir = pathutil.ExpandHomePath(dir)
	if shortTermDays <= 0 {
		shortTermDays = 7
	}
	return &Manager{Dir: dir, ShortTermDays: shortTermDays, Now: time.Now}
}

func (m *Manager) memoryRoot() string {
	if m == nil {
		return ""
	}
	return m.Dir
}

func (m *Manager) LongTermPath(subjectID string) (string, string) {
	root := m.memoryRoot()
	if root == "" {
		return "", ""
	}
	cleanID := SanitizeSubjectID(subjectID)
	rel := filepath.ToSlash(filepath.Join(longTermDirName, cleanID, shortTermIndexName))
	abs := filepath.Join(root, rel)
	return abs, rel
}

func (m *Manager) ShortTermPath(date time.Time) (string, string) {
	return m.ShortTermSessionPath(date, "session")
}

func (m *Manager) ShortTermDayDir(date time.Time) (string, string) {
	root := m.memoryRoot()
	if root == "" {
		return "", ""
	}
	day := date.UTC().Format("2006-01-02")
	rel := filepath.ToSlash(day)
	abs := filepath.Join(root, rel)
	return abs, rel
}

func (m *Manager) ShortTermSessionPath(date time.Time, sessionID string) (string, string) {
	root := m.memoryRoot()
	if root == "" {
		return "", ""
	}
	day := date.UTC().Format("2006-01-02")
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = "session"
	}
	cleanID := SanitizeSubjectID(sessionID)
	if cleanID == "" {
		cleanID = "session"
	}
	filename := cleanID + ".md"
	rel := filepath.ToSlash(filepath.Join(day, filename))
	abs := filepath.Join(root, rel)
	return abs, rel
}

func (m *Manager) EnsureDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return os.MkdirAll(path, 0o700)
}

func SanitizeSubjectID(subjectID string) string {
	subjectID = strings.TrimSpace(subjectID)
	if subjectID == "" {
		return "unknown"
	}
	var b strings.Builder
	b.Grow(len(subjectID))
	lastUnderscore := false
	for _, r := range subjectID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastUnderscore = false
		case r == '-' || r == '_':
			b.WriteRune(r)
			lastUnderscore = false
		default:
			if !lastUnderscore {
				b.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	out := strings.Trim(b.String(), "_-")
	if out == "" {
		return "unknown"
	}
	return out
}
