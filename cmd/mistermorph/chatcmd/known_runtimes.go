package chatcmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// known_runtimes pins each Console runtime's identity key for elevated-command approvals, like
// SSH's known_hosts: a JSON object from the runtime's base URL to its identity (base64url). An
// approval from a runtime whose identity differs from its pin is refused until the person removes
// the pin (mistermorph chat --forget-runtime <url>).
const knownRuntimesFile = "known_runtimes"

// chatStateDir is chat's own state directory: file_state_dir, or the default.
func chatStateDir() string {
	dir := strings.TrimSpace(viper.GetString("file_state_dir"))
	if dir == "" {
		dir = statepaths.FileStateDir()
	}
	return pathutil.ResolveStateDir(dir)
}

func knownRuntimesPath() string {
	return filepath.Join(chatStateDir(), knownRuntimesFile)
}

// runtimeTrustKey is the name a runtime is pinned under: its base URL, as --runtime-url resolves
// it.
func runtimeTrustKey(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("the runtime address must be an HTTP(S) URL, as given to --runtime-url")
	}
	u.User, u.RawQuery, u.Fragment = nil, "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

// runtimeIsLoopback reports whether the runtime at key runs on this machine: its identity is then
// pinned without asking.
func runtimeIsLoopback(key string) bool {
	u, err := url.Parse(key)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func loadKnownRuntimes(path string) (map[string]string, error) {
	known := map[string]string{}
	if strings.TrimSpace(path) == "" {
		return known, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return known, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return known, nil
	}
	if err := json.Unmarshal(data, &known); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return known, nil
}

func saveKnownRuntimes(path string, known map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(known, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+knownRuntimesFile+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// pinKnownRuntime records identity for key, keeping the other entries.
func pinKnownRuntime(path, key, identity string) error {
	known, err := loadKnownRuntimes(path)
	if err != nil {
		return err
	}
	known[key] = identity
	return saveKnownRuntimes(path, known)
}

// forgetKnownRuntime removes key's entry and reports whether there was one.
func forgetKnownRuntime(path, key string) (bool, error) {
	known, err := loadKnownRuntimes(path)
	if err != nil {
		return false, err
	}
	if _, ok := known[key]; !ok {
		return false, nil
	}
	delete(known, key)
	return true, saveKnownRuntimes(path, known)
}

// runForgetRuntime is chat --forget-runtime <url>.
func runForgetRuntime(cmd *cobra.Command, raw, path string) error {
	key, err := runtimeTrustKey(raw)
	if err != nil {
		return err
	}
	found, err := forgetKnownRuntime(path, key)
	if err != nil {
		return fmt.Errorf("forget runtime: %w", err)
	}
	if found {
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "Forgot the identity pinned for %s. The next approval from it pins its identity again.\n", key)
		return nil
	}
	_, _ = fmt.Fprintf(cmd.OutOrStdout(), "No identity is pinned for %s.\n", key)
	return nil
}
