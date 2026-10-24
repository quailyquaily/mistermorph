package secretkeys

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

// LedgerFileName is the ledger's file in the state directory.
const LedgerFileName = "secret_keys.json"

// LedgerPath is where the ledger of the config whose file_state_dir is stateDir lives. With no
// state directory set (a reader without the config defaults) there is no ledger: "".
func LedgerPath(stateDir string) string {
	if strings.TrimSpace(stateDir) == "" {
		return ""
	}
	return filepath.Join(pathutil.ResolveStateDir(stateDir), LedgerFileName)
}

// Saved records when a key was first saved in the config and in which field. A zero At means the
// key was already there when the ledger started, so when it was saved is not known.
type Saved struct {
	At   time.Time `json:"at,omitzero"`
	Path string    `json:"path"`
}

type ledgerFile struct {
	Keys map[string]Saved `json:"keys"`
}

var ledgerMu sync.Mutex

// Sync brings the ledger at path (none when empty) up to date with fields, the secret fields now in the config, and
// returns it by key identity. A key not seen before is recorded as saved at now in its first field;
// keys no longer in the config are dropped. A new ledger starts from baseline, the fields that were
// already there (such as the config before a save), recorded without a time.
func Sync(path string, baseline, fields []Field, now time.Time) (map[string]Saved, error) {
	if path == "" {
		return map[string]Saved{}, nil
	}
	ledgerMu.Lock()
	defer ledgerMu.Unlock()

	keys, existed, err := readLedger(path)
	if err != nil {
		return nil, err
	}
	changed := !existed
	if !existed {
		for _, field := range baseline {
			if id := Identity(field.Raw); keys[id].Path == "" {
				keys[id] = Saved{Path: field.Path}
			}
		}
	}
	present := map[string]bool{}
	for _, field := range fields {
		id := Identity(field.Raw)
		present[id] = true
		if _, ok := keys[id]; ok {
			continue
		}
		keys[id] = Saved{At: now.UTC().Truncate(time.Second), Path: field.Path}
		changed = true
	}
	for id := range keys {
		if !present[id] {
			delete(keys, id)
			changed = true
		}
	}
	if changed {
		raw, err := json.MarshalIndent(ledgerFile{Keys: keys}, "", "  ")
		if err != nil {
			return nil, err
		}
		if err := fsstore.WriteTextAtomic(path, string(raw)+"\n", fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600}); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

func readLedger(path string) (map[string]Saved, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]Saved{}, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var file ledgerFile
	if err := json.Unmarshal(raw, &file); err != nil {
		// A damaged ledger only loses dates; start it again.
		return map[string]Saved{}, false, nil
	}
	if file.Keys == nil {
		file.Keys = map[string]Saved{}
	}
	return file.Keys, true, nil
}
