// Package topicstate keeps what a conversation holds apart from its messages. Its context use,
// request snapshot and workspace are rows of agent.db keyed by the conversation key; its context
// checkpoint and found tools are files in its own folder under file_state_dir/topics.
package topicstate

import (
	"context"

	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
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

// Remove deletes a conversation's rows in agent.db, in one transaction, then its folder and
// everything in it.
func Remove(stateDir string, conversationKey string) error {
	dir := Dir(stateDir, conversationKey)
	if dir == "" {
		return nil
	}
	db, err := agentdb.OpenStateDir(context.Background(), stateDir)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if err := RemoveRows(context.Background(), db, conversationKey); err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// RemoveIfEmpty deletes a conversation's folder once nothing is left in it.
func RemoveIfEmpty(stateDir string, conversationKey string) {
	if dir := Dir(stateDir, conversationKey); dir != "" {
		_ = os.Remove(dir)
	}
}
