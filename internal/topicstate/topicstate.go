// Package topicstate places a conversation's state in its own folder under
// file_state_dir/topics, so everything kept for one topic sits together and goes away with it.
package topicstate

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// DirName is the folder under file_state_dir that holds the topic folders.
const DirName = "topics"

// Key is the name of a conversation's folder: a hash of the conversation key, which may hold
// characters a file name cannot.
func Key(conversationKey string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(conversationKey)))
	return hex.EncodeToString(sum[:12])
}

// Dir is the folder that holds a conversation's state, or "" without a state dir or key.
func Dir(stateDir string, conversationKey string) string {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" || strings.TrimSpace(conversationKey) == "" {
		return ""
	}
	return filepath.Join(stateDir, DirName, Key(conversationKey))
}

// LockPath is the lock that guards writes to a conversation's folder.
func LockPath(stateDir string, conversationKey string) string {
	return filepath.Join(strings.TrimSpace(stateDir), "locks", "topic_"+Key(conversationKey)+".lck")
}

// Remove deletes a conversation's folder and everything in it.
func Remove(stateDir string, conversationKey string) error {
	dir := Dir(stateDir, conversationKey)
	if dir == "" {
		return nil
	}
	return os.RemoveAll(dir)
}

// RemoveIfEmpty deletes a conversation's folder once nothing is left in it.
func RemoveIfEmpty(stateDir string, conversationKey string) {
	if dir := Dir(stateDir, conversationKey); dir != "" {
		_ = os.Remove(dir)
	}
}
