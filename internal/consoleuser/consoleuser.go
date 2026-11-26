// Package consoleuser is the Console's human: the one person who uses a Console, known to the
// rest of the system as console:user. Only the name they are addressed by can be set
// (console.user_name); the identifiers never change.
package consoleuser

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// ParticipantKey identifies the Console's human in conversations, contacts and routing.
	ParticipantKey = "console:user"
	// Username is the Console human's account name.
	Username = "console"
	// DefaultDisplayName names the Console's human when no name is saved, and in records written
	// before a name could be saved.
	DefaultDisplayName = "Console User"
	// ConfigKey is where the saved name is kept in the config.
	ConfigKey = "console.user_name"
	// MaxNameLength is the longest name, in Unicode code points.
	MaxNameLength = 80
)

// isSurroundingSpace reports the characters dropped from both ends of a name: Unicode white space
// and the byte order mark. The Console's own check (web/console-nsh/lib/core/console-user.js)
// drops the same set.
func isSurroundingSpace(r rune) bool {
	return unicode.IsSpace(r) || r == '\ufeff'
}

// NormalizeName is name as it is saved: without the white space around it. It refuses an empty
// name, one longer than MaxNameLength code points, and one with a line break or a control
// character; nothing is cut or replaced.
func NormalizeName(name string) (string, error) {
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("must be valid text")
	}
	name = strings.TrimFunc(name, isSurroundingSpace)
	if name == "" {
		return "", fmt.Errorf("must not be empty")
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return "", fmt.Errorf("must be one line without control characters")
		}
	}
	if utf8.RuneCountInString(name) > MaxNameLength {
		return "", fmt.Errorf("must be at most %d characters", MaxNameLength)
	}
	return name, nil
}

// DisplayName is the name to show for a saved value: the saved name when it is a valid one, else
// DefaultDisplayName.
func DisplayName(saved string) string {
	if name, err := NormalizeName(saved); err == nil {
		return name
	}
	return DefaultDisplayName
}
