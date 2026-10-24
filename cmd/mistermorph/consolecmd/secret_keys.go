package consolecmd

import (
	"context"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/secretkeys"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// The secret picker: the keys already in config.yaml, so a field can reuse one instead of the
// key being pasted again. Each key is listed once however many fields use it, with a masked hint
// ("sk-proj-…a1b2"), the fields using it, and when and where it was first saved. No key value is
// sent; picking one copies its reference (${secret:...}, ${ENV}, ${aws-sm:...}) into the field,
// and a key kept in config.yaml as plain text is copied through a reveal.

type secretKeyPayload struct {
	ID string `json:"id"`
	// Kind is where the key is kept: "os", "env", "aws" or "file".
	Kind string `json:"kind"`
	// Ref is the reference to put in a field to use this key; empty for a plain-text key, which is
	// revealed from RevealPath instead.
	Ref        string `json:"ref,omitempty"`
	RevealPath string `json:"reveal_path,omitempty"`
	Hint       string `json:"hint,omitempty"`
	// Unavailable is set when the key could not be read (a missing variable, a deleted secret).
	Unavailable bool     `json:"unavailable,omitempty"`
	UsedBy      []string `json:"used_by"`
	SavedAt     string   `json:"saved_at,omitempty"`
	SavedIn     string   `json:"saved_in,omitempty"`
}

// Preference among the kinds when a key is kept more than one way: a reference beats plain text.
var secretKindRank = map[string]int{"os": 0, "env": 1, "aws": 2, "file": 3}

func (s *server) handleSecretKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	configPath := strings.TrimSpace(s.cfg.configPath)
	if configPath == "" {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "keys": []secretKeyPayload{}})
		return
	}
	raw, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		writeError(w, http.StatusServiceUnavailable, "config file could not be read")
		return
	}
	var doc yaml.Node
	if len(raw) > 0 {
		if err := yaml.Unmarshal(raw, &doc); err != nil {
			writeError(w, http.StatusServiceUnavailable, "config file could not be parsed")
			return
		}
	}
	reader := viper.GetViper()
	if s.localRuntime != nil {
		reader = s.localRuntime.currentConfigReader()
	}
	fields := secretkeys.Collect(&doc)
	saved, err := secretkeys.Sync(s.secretKeyLedgerPath(), fields, fields, time.Now())
	if err != nil {
		s.logger().Warn("secret_keys_ledger_failed", "error", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	keys := listSecretKeys(ctx, fields, secref.NewResolver(configutil.SecretRefSourceFromReader(reader)), saved)
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "keys": keys})
}

// syncSecretKeyLedger records the keys a settings save added, so the picker can say when each was
// saved. previous and next are config.yaml before and after the save.
func (s *server) syncSecretKeyLedger(previous, next []byte) {
	if _, err := secretkeys.Sync(s.secretKeyLedgerPath(), secretkeys.CollectBytes(previous), secretkeys.CollectBytes(next), time.Now()); err != nil {
		s.logger().Warn("secret_keys_ledger_failed", "error", err)
	}
}

// secretKeyLedgerPath is the ledger in the local runtime's state directory; none without one.
func (s *server) secretKeyLedgerPath() string {
	return secretkeys.LedgerPath(s.currentRuntimeConfigReader().GetString("file_state_dir"))
}

// listSecretKeys groups fields by the key they hold, newest first. Fields holding the same key
// through different references (two stored copies of one key) are one key.
func listSecretKeys(ctx context.Context, fields []secretkeys.Field, resolver *secref.Resolver, saved map[string]secretkeys.Saved) []secretKeyPayload {
	type group struct {
		key      secretKeyPayload
		savedAt  time.Time
		hasSaved bool
	}
	groups := map[string]*group{}
	var order []string
	for _, field := range fields {
		groupKey := "ref:" + secretkeys.Identity(field.Raw)
		hint := ""
		unavailable := false
		result, err := resolver.ResolveString(ctx, field.Raw, secref.Options{EnvMissing: secref.EnvMissingError})
		if err == nil && len(result.MissingEnv) == 0 && strings.TrimSpace(result.Value) != "" {
			value := strings.TrimSpace(result.Value)
			groupKey = "value:" + secretkeys.ValueHash(value)
			hint = secretkeys.Hint(value)
		} else {
			unavailable = true
		}
		g := groups[groupKey]
		if g == nil {
			g = &group{key: secretKeyPayload{ID: secretkeys.ValueHash(groupKey), Hint: hint, Unavailable: unavailable}}
			groups[groupKey] = g
			order = append(order, groupKey)
		}
		g.key.UsedBy = append(g.key.UsedBy, field.Path)
		kind := secretkeys.Kind(field.Raw)
		if g.key.Kind == "" || secretKindRank[kind] < secretKindRank[g.key.Kind] {
			g.key.Kind = kind
			if kind == "file" {
				g.key.Ref, g.key.RevealPath = "", field.Path
			} else {
				g.key.Ref, g.key.RevealPath = strings.TrimSpace(field.Raw), ""
			}
		}
		// The earliest known save of any copy is when this key was saved.
		if entry, ok := saved[secretkeys.Identity(field.Raw)]; ok {
			if !g.hasSaved || (!entry.At.IsZero() && (g.savedAt.IsZero() || entry.At.Before(g.savedAt))) {
				g.savedAt, g.key.SavedIn, g.hasSaved = entry.At, entry.Path, true
			}
		}
	}
	keys := make([]secretKeyPayload, 0, len(order))
	for _, groupKey := range order {
		g := groups[groupKey]
		sort.Strings(g.key.UsedBy)
		if !g.savedAt.IsZero() {
			g.key.SavedAt = g.savedAt.UTC().Format(time.RFC3339)
		}
		keys = append(keys, g.key)
	}
	// Newest first; keys saved before the ledger keep their order in config.yaml after those.
	sort.SliceStable(keys, func(i, j int) bool {
		return keys[i].SavedAt > keys[j].SavedAt
	})
	return keys
}
