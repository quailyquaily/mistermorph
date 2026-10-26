package seal

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LoadIdentity reads the identity kept at path (its seed, base64url), or makes one and keeps it
// there, readable by this user only, when there is none.
func LoadIdentity(path string) (*Identity, error) {
	identity, err := ReadIdentity(path)
	if !errors.Is(err, os.ErrNotExist) {
		return identity, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("keep the elevation identity: %w", err)
	}
	// O_EXCL: when another process made one first, use that.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return LoadIdentity(path)
	}
	if err != nil {
		return nil, fmt.Errorf("keep the elevation identity: %w", err)
	}
	_, writeErr := file.WriteString(b64.EncodeToString(seed) + "\n")
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("keep the elevation identity: %w", errors.Join(writeErr, closeErr))
	}
	return NewIdentity(seed)
}

// ReadIdentity reads the identity kept at path, without making one. A missing file is
// os.ErrNotExist.
func ReadIdentity(path string) (*Identity, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("read the elevation identity: %w", err)
	}
	seed, err := b64.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("read the elevation identity %s: %w", path, err)
	}
	return NewIdentity(seed)
}
