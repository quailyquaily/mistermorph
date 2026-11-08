package consolecmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configstore"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/onboardingcheck"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

type setupRepairFilePayload struct {
	Content string `json:"content"`
}

type setupRepairSecretPayload struct {
	FieldPath []string `json:"field_path"`
	Value     string   `json:"value"`
}

func (s *server) handleSetupIntegrity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items := onboardingcheck.BrokenItems(onboardingcheck.Check(configPath, s.setupRepairStateDir(), s.setupRepairSecretSource()))
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
}

func (s *server) handleSetupRepairSecret(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req setupRepairSecretPayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	for i := range req.FieldPath {
		req.FieldPath[i] = strings.TrimSpace(req.FieldPath[i])
		if req.FieldPath[i] == "" {
			writeError(w, http.StatusBadRequest, "invalid field path")
			return
		}
	}
	if len(req.FieldPath) == 0 {
		writeError(w, http.StatusBadRequest, "field path is required")
		return
	}

	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	raw, err := configstore.ReadFile(configPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	doc, err := configbootstrap.LoadDocumentBytes(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	root, err := configbootstrap.DocumentMapping(doc)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	parent, valueNode := findRepairConfigField(root, req.FieldPath)
	if parent == nil || valueNode == nil || valueNode.Kind != yaml.ScalarNode {
		writeError(w, http.StatusBadRequest, "config field is not a secret reference")
		return
	}
	ref, ok := secref.ParseSingleRef(valueNode.Value)
	if !ok || ref.Kind != secref.RefKindOS {
		writeError(w, http.StatusBadRequest, "config field is not an OS secret reference")
		return
	}

	switch r.Method {
	case http.MethodPut:
		if req.Value == "" {
			writeError(w, http.StatusBadRequest, "secret value is required")
			return
		}
		if s == nil || s.secretStore == nil {
			writeError(w, http.StatusServiceUnavailable, secref.ErrOSStoreUnavailable.Error())
			return
		}
		if err := s.secretStore.Put(r.Context(), ref.SecretID, strings.Join(req.FieldPath, "."), []byte(req.Value)); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
	case http.MethodDelete:
		configbootstrap.DeleteMappingKey(parent, req.FieldPath[len(req.FieldPath)-1])
		updated, err := configbootstrap.MarshalDocument(doc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := writeRepairFile(configPath, updated); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if s != nil && s.secretStore != nil {
			_ = s.secretStore.Delete(r.Context(), ref.SecretID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleSetupRepairFile(w http.ResponseWriter, r *http.Request) {
	item, err := s.resolveSetupRepairFile(r.URL.Query().Get("key"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if item.Key == onboardingcheck.FileKeyIdentity || item.Key == onboardingcheck.FileKeySoul {
		s.handleSetupRepairPersona(w, r, item)
		return
	}
	switch r.Method {
	case http.MethodGet:
		raw, err := os.ReadFile(item.Path)
		if err != nil {
			if os.IsNotExist(err) {
				writeError(w, http.StatusNotFound, fmt.Sprintf("%s is missing", item.Name))
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"key":     item.Key,
			"name":    item.Name,
			"path":    item.Path,
			"content": string(raw),
		})
	case http.MethodPut:
		var req setupRepairFilePayload
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := os.MkdirAll(filepath.Dir(item.Path), 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := writeRepairFile(item.Path, []byte(req.Content)); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		next, err := s.resolveSetupRepairFile(item.Key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"item": next,
		})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *server) resolveSetupRepairFile(rawKey string) (onboardingcheck.Item, error) {
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		return onboardingcheck.Item{}, err
	}
	stateDir := s.setupRepairStateDir()
	switch strings.TrimSpace(rawKey) {
	case onboardingcheck.FileKeyConfig:
		return onboardingcheck.InspectConfigPath(configPath, s.setupRepairSecretSource()), nil
	case onboardingcheck.FileKeyIdentity:
		identity, _ := onboardingcheck.InspectPersona(stateDir)
		return identity, nil
	case onboardingcheck.FileKeySoul:
		_, soul := onboardingcheck.InspectPersona(stateDir)
		return soul, nil
	default:
		return onboardingcheck.Item{}, fmt.Errorf("invalid repair file key")
	}
}

func (s *server) setupRepairSecretSource() secref.Source {
	var store secref.OSStore
	if s != nil {
		store = s.secretStore
	}
	return secref.NewDefaultSourceWithOSStore(
		configutil.AWSSecretsManagerConfigFromReader(viper.GetViper()),
		store,
	)
}

func findRepairConfigField(root *yaml.Node, path []string) (*yaml.Node, *yaml.Node) {
	if root == nil || root.Kind != yaml.MappingNode || len(path) == 0 {
		return nil, nil
	}
	parent := root
	for _, key := range path[:len(path)-1] {
		parent = configbootstrap.FindMappingValue(parent, key)
		if parent == nil || parent.Kind != yaml.MappingNode {
			return nil, nil
		}
	}
	return parent, configbootstrap.FindMappingValue(parent, path[len(path)-1])
}

func (s *server) setupRepairStateDir() string {
	if s != nil && strings.TrimSpace(s.cfg.stateDir) != "" {
		return s.cfg.stateDir
	}
	return pathutil.ResolveStateDir(viper.GetString("file_state_dir"))
}

func writeRepairFile(path string, content []byte) error {
	if configstore.IsDBConfigPath(path) {
		return configstore.WriteFileBy(path, content, configstore.ByConsole)
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	return fsstore.WriteTextAtomic(path, string(content), fsstore.FileOptions{FilePerm: mode})
}

// handleSetupRepairPersona serves the identity and the soul, which are rows of agent.db, in the
// file shapes the repair page edits: identity.yaml and soul.md.
func (s *server) handleSetupRepairPersona(w http.ResponseWriter, r *http.Request, item onboardingcheck.Item) {
	ctx := r.Context()
	store, err := personastore.ForStateDir(ctx, s.setupRepairStateDir())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	switch r.Method {
	case http.MethodGet:
		id, ok, err := store.Identity(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		content := ""
		if item.Key == onboardingcheck.FileKeyIdentity {
			if item.Status == onboardingcheck.StatusMalformed {
				// The rejected file, to repair.
				if raw, err := os.ReadFile(item.Path); err == nil {
					writeJSON(w, http.StatusOK, map[string]any{"key": item.Key, "name": item.Name, "path": item.Path, "content": string(raw)})
					return
				}
			}
			if !ok {
				writeError(w, http.StatusNotFound, fmt.Sprintf("%s is missing", item.Name))
				return
			}
			content = personastore.RenderIdentityYAML(id)
		} else {
			if !ok || strings.TrimSpace(id.Soul) == "" {
				writeError(w, http.StatusNotFound, fmt.Sprintf("%s is missing", item.Name))
				return
			}
			content = personastore.RenderSoul(id.Soul)
		}
		writeJSON(w, http.StatusOK, map[string]any{"key": item.Key, "name": item.Name, "path": item.Path, "content": content})
	case http.MethodPut:
		var req setupRepairFilePayload
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		var patch personastore.IdentityPatch
		if item.Key == onboardingcheck.FileKeyIdentity {
			parsed, err := personastore.ParseIdentityYAML(req.Content)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			patch = personastore.IdentityPatch{Name: &parsed.Name, NameAlts: &parsed.NameAlts, Creature: &parsed.Creature,
				Vibe: &parsed.Vibe, Emoji: &parsed.Emoji, Extra: &parsed.Extra}
		} else {
			soul := personastore.ParseSoul(req.Content)
			patch = personastore.IdentityPatch{Soul: &soul}
		}
		if _, err := store.PatchIdentity(ctx, patch, personastore.ByConsole); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if item.Key == onboardingcheck.FileKeyIdentity {
			// The rejected file is repaired; keep it beside the others the import read.
			stateDir := s.setupRepairStateDir()
			if _, found := onboardingcheck.RejectedIdentityFile(ctx, store, stateDir); found {
				broken := filepath.Join(stateDir, statepaths.PersonaDirName, statepaths.IdentityFilename)
				if _, err := os.Stat(broken + ".imported"); os.IsNotExist(err) {
					_ = os.Rename(broken, broken+".imported")
				} else {
					_ = os.Rename(broken, broken+".rejected")
				}
			}
		}
		next, err := s.resolveSetupRepairFile(item.Key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "item": next})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
