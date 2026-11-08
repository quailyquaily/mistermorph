package onboardingcheck

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

type Status string

const (
	StatusOK         Status = "ok"
	StatusMissing    Status = "missing"
	StatusUnreadable Status = "unreadable"
	StatusMalformed  Status = "malformed"
)

const (
	FileKeyConfig   = "config"
	FileKeyIdentity = "identity"
	FileKeySoul     = "soul"
)

const (
	CodeFileUnreadable           = "file_unreadable"
	CodeConfigEmpty              = "config_empty"
	CodeConfigInvalid            = "config_invalid"
	CodeInvalidSecretRef         = "invalid_secret_ref"
	CodeOSSecretNotFound         = "os_secret_not_found"
	CodeOSSecretStoreUnavailable = "os_secret_store_unavailable"
	CodeIdentityInvalid          = "identity_invalid"
)

type Item struct {
	Key       string   `json:"key"`
	Name      string   `json:"name"`
	Path      string   `json:"path"`
	Stage     string   `json:"stage"`
	Status    Status   `json:"status"`
	Error     string   `json:"error,omitempty"`
	Code      string   `json:"code,omitempty"`
	FieldPath []string `json:"field_path,omitempty"`
}

func (i Item) IsBroken() bool {
	return i.Status == StatusUnreadable || i.Status == StatusMalformed
}

func Check(configPath string, stateDir string, source secref.Source) []Item {
	stateDir = strings.TrimSpace(stateDir)
	identity, soul := InspectPersona(stateDir)
	return []Item{
		InspectConfigPath(configPath, source),
		identity,
		soul,
	}
}

// InspectPersona reports the identity and the soul, which are in agent.db: the identity is there
// once it has a row, the soul once that row has one. A row cannot be malformed; a database that
// cannot be read makes both unreadable.
func InspectPersona(stateDir string) (Item, Item) {
	stateDir = strings.TrimSpace(stateDir)
	identity := baseItem(FileKeyIdentity, "identity.yaml", "persona", filepath.Join(stateDir, "agent.db"))
	soul := baseItem(FileKeySoul, "soul.md", "soul", filepath.Join(stateDir, "agent.db"))
	ctx := context.Background()
	store, err := personastore.ForStateDir(ctx, stateDir)
	var id personastore.Identity
	var ok bool
	if err == nil {
		id, ok, err = store.Identity(ctx)
	}
	if err != nil {
		for _, item := range []*Item{&identity, &soul} {
			item.Status = StatusUnreadable
			item.Code = CodeFileUnreadable
			item.Error = err.Error()
		}
		return identity, soul
	}
	if ok {
		identity.Status = StatusOK
		if strings.TrimSpace(id.Soul) != "" {
			soul.Status = StatusOK
		}
	}
	// An identity.yaml the import could not parse stays where it was; until it is repaired the
	// identity is reported as malformed, as the file was.
	if reject, found := RejectedIdentityFile(ctx, store, stateDir); found {
		identity.Path = filepath.Join(stateDir, "persona", "identity.yaml")
		identity.Status = StatusMalformed
		identity.Code = CodeIdentityInvalid
		identity.Error = reject
	}
	return identity, soul
}

// RejectedIdentityFile reports the error of an identity.yaml the import rejected, while the file
// is still in place.
func RejectedIdentityFile(ctx context.Context, store *personastore.Store, stateDir string) (string, bool) {
	path := filepath.Join(stateDir, "persona", "identity.yaml")
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	rejects, err := agentdb.Rejects(ctx, store.DB(), "persona")
	if err != nil {
		return "", false
	}
	for _, reject := range rejects.Rejects {
		if reject.Source == "persona/identity.yaml" {
			return reject.Error, true
		}
	}
	return "", false
}

func BrokenItems(items []Item) []Item {
	out := make([]Item, 0, len(items))
	for _, item := range items {
		if item.IsBroken() {
			out = append(out, item)
		}
	}
	return out
}

func InspectConfigPath(path string, source secref.Source) Item {
	item := baseItem(FileKeyConfig, "config.yaml", "llm", path)
	raw, err := configstore.ReadFile(item.Path)
	if err != nil {
		return itemForReadError(item, err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		item.Status = StatusMalformed
		item.Code = CodeConfigEmpty
		item.Error = "config.yaml is empty"
		return item
	}
	tmp := viper.New()
	if err := configutil.ReadExpandedConfigWithSource(tmp, item.Path, source, nil); err != nil {
		item.Status = StatusMalformed
		item.Code = configIssueCode(err)
		var refErr *configutil.ScalarReferenceError
		if errors.As(err, &refErr) {
			item.FieldPath = append([]string(nil), refErr.Path...)
		}
		item.Error = fmt.Sprintf("invalid config yaml: %v", err)
		return item
	}
	item.Status = StatusOK
	return item
}

func InspectIdentityYAMLPath(path string) Item {
	item := baseItem(FileKeyIdentity, "identity.yaml", "persona", path)
	raw, err := os.ReadFile(item.Path)
	if err != nil {
		return itemForReadError(item, err)
	}
	if err := ValidateIdentityYAML(string(raw)); err != nil {
		item.Status = StatusMalformed
		item.Code = CodeIdentityInvalid
		item.Error = err.Error()
		return item
	}
	item.Status = StatusOK
	return item
}

func InspectSoulPath(path string) Item {
	item := baseItem(FileKeySoul, filepath.Base(strings.TrimSpace(path)), "soul", path)
	if item.Name == "." || item.Name == "" {
		item.Name = "soul.md"
	}
	_, err := os.ReadFile(item.Path)
	if err != nil {
		return itemForReadError(item, err)
	}
	item.Status = StatusOK
	return item
}

func ValidateIdentityYAML(raw string) error {
	content := strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	if content == "" {
		return fmt.Errorf("identity.yaml is empty")
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		return fmt.Errorf("identity.yaml is invalid: %w", err)
	}
	root := &doc
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return fmt.Errorf("identity.yaml is empty")
		}
		root = doc.Content[0]
	}
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("identity.yaml must be a mapping")
	}
	return nil
}

func baseItem(key string, name string, stage string, path string) Item {
	return Item{
		Key:    key,
		Name:   name,
		Path:   filepath.Clean(strings.TrimSpace(path)),
		Stage:  stage,
		Status: StatusMissing,
	}
}

func itemForReadError(item Item, err error) Item {
	if os.IsNotExist(err) {
		item.Status = StatusMissing
		return item
	}
	item.Status = StatusUnreadable
	item.Code = CodeFileUnreadable
	item.Error = err.Error()
	return item
}

func configIssueCode(err error) string {
	switch {
	case errors.Is(err, secref.ErrInvalidSecretRef):
		return CodeInvalidSecretRef
	case errors.Is(err, secref.ErrOSSecretNotFound):
		return CodeOSSecretNotFound
	case errors.Is(err, secref.ErrOSStoreUnavailable), errors.Is(err, secref.ErrOSSecretResolveFailed):
		return CodeOSSecretStoreUnavailable
	default:
		return CodeConfigInvalid
	}
}
