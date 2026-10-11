// Package agentlink is the built-in Agent Link channel: agents that a Console connects to as
// endpoints message each other through that Console. A runtime keeps one Node, which queues the
// messages it sends and accepts the ones the Console delivers; a Console runs a Relay, which
// carries messages between the Nodes connected to it.
package agentlink

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// InstanceIDFile is the file under the state dir that holds the runtime's instance ID.
const InstanceIDFile = "instance_id"

var instanceIDPattern = regexp.MustCompile(`^inst_[0-9a-f]{32}$`)

// LoadOrCreateInstanceID returns the instance ID saved in stateDir, generating and saving a random
// one on first use. Every process sharing stateDir gets the same ID.
func LoadOrCreateInstanceID(stateDir string) (string, error) {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return "", fmt.Errorf("state dir is required")
	}
	path := filepath.Join(filepath.Clean(stateDir), InstanceIDFile)
	if id, ok, err := readInstanceID(path); err != nil || ok {
		return id, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	id, err := newInstanceID()
	if err != nil {
		return "", err
	}
	// Write a temp file and link it into place, so a concurrent first start cannot see a partial
	// file and only one generated ID wins.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".instance_id-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.WriteString(id + "\n"); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Link(tmpPath, path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	id, ok, err := readInstanceID(path)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("instance id file %s is empty", path)
	}
	return id, nil
}

func readInstanceID(path string) (string, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	id := strings.TrimSpace(string(raw))
	if id == "" {
		return "", false, nil
	}
	if !instanceIDPattern.MatchString(id) {
		return "", false, fmt.Errorf("invalid instance id in %s", path)
	}
	return id, true, nil
}

func newInstanceID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "inst_" + hex.EncodeToString(buf[:]), nil
}

// ValidInstanceID reports whether id has the instance ID format.
func ValidInstanceID(id string) bool {
	return instanceIDPattern.MatchString(strings.TrimSpace(id))
}
