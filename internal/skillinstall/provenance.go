package skillinstall

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// ProvenanceFile is written into every installed skill's folder.
const ProvenanceFile = ".mistermorph-skill.json"

// Provenance records where an installed skill came from and what was installed.
type Provenance struct {
	Source      Source            `json:"source"`
	InstalledAt time.Time         `json:"installed_at"`
	Files       map[string]string `json:"files"` // path -> sha256
}

// ReadProvenance reads a skill folder's provenance; ok is false for skills added by hand.
func ReadProvenance(dir string) (Provenance, bool) {
	data, err := os.ReadFile(filepath.Join(dir, ProvenanceFile))
	if err != nil {
		return Provenance{}, false
	}
	var p Provenance
	if json.Unmarshal(data, &p) != nil {
		return Provenance{}, false
	}
	return p, true
}

// ModifiedFiles lists recorded files whose content changed or went missing since install.
func (p Provenance) ModifiedFiles(dir string) []string {
	var changed []string
	for rel, want := range p.Files {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			changed = append(changed, rel)
			continue
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != want {
			changed = append(changed, rel)
		}
	}
	return changed
}

func writeProvenance(dir string, p Provenance) error {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ProvenanceFile), append(data, '\n'), 0o644)
}
