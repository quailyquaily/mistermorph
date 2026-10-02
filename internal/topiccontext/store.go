package topiccontext

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"text/template"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
	"github.com/quailyquaily/mistermorph/llm"
)

var contextCommandTemplate = template.Must(template.New("context-command").Funcs(template.FuncMap{
	"formatPercent": formatPercent,
	"formatTokens":  formatInt64,
}).Parse(strings.TrimSpace(`
**Context**

{{ if gt .ContextWindowTokens 0 -}}
- **Window used:** {{ formatPercent .UsageRatio }}
- **Used input:** {{ formatTokens .UsedInputTokens }} / {{ formatTokens .ContextWindowTokens }} tokens
- **Cached input:** {{ formatTokens .CachedInputTokens }} tokens
{{ else -}}
- **Window used:** unknown
- **Used input:** {{ formatTokens .UsedInputTokens }} tokens
- **Context window:** unknown
{{ end -}}
- **Model:** {{ .Model }}
- **Updated:** {{ .UpdatedAt }}
`)))

type Item struct {
	ConversationKey          string  `json:"conversation_key"`
	TopicID                  string  `json:"topic_id,omitempty"`
	Runtime                  string  `json:"runtime,omitempty"`
	Model                    string  `json:"model,omitempty"`
	NormalizedModel          string  `json:"normalized_model,omitempty"`
	ContextWindowTokens      int64   `json:"context_window_tokens,omitempty"`
	ContextWindowSource      string  `json:"context_window_source,omitempty"`
	UsedInputTokens          int64   `json:"used_input_tokens,omitempty"`
	CachedInputTokens        int64   `json:"cached_input_tokens,omitempty"`
	CacheCreationInputTokens int64   `json:"cache_creation_input_tokens,omitempty"`
	UsageRatio               float64 `json:"usage_ratio,omitempty"`
	LastRunID                string  `json:"last_run_id,omitempty"`
	LastOriginEventID        string  `json:"last_origin_event_id,omitempty"`
	UpdatedAt                string  `json:"updated_at,omitempty"`
}

type UsageSample struct {
	RunID                    string
	OriginEventID            string
	Scene                    string
	Provider                 string
	APIBase                  string
	Model                    string
	ContextWindowTokens      int64
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	UpdatedAt                time.Time
}

// Store keeps each conversation's context usage in its topic folder, file_state_dir/topics/<key>/
// context.json. path names the old shared file, topic_context.json in the state dir; whatever it
// still holds is moved into the topic folders the first time the store is used.
type Store struct {
	path      string
	stateDir  string
	mu        sync.Mutex
	migrateMu sync.Mutex
	migrated  bool
}

type storeFile struct {
	Version int             `json:"version"`
	Items   map[string]Item `json:"items"`
}

const contextFileName = "context.json"

func NewStore(path string) *Store {
	path = strings.TrimSpace(path)
	stateDir := ""
	if path != "" {
		stateDir = filepath.Dir(path)
	}
	return &Store{path: path, stateDir: stateDir}
}

func (s *Store) ObserveUsage(ctx context.Context, sample UsageSample) {
	scope, ok := ScopeFromContext(ctx)
	if !ok || !shouldTrackScene(sample.Scene) || sample.InputTokens <= 0 {
		return
	}
	_ = s.UpdateFromSample(scope, sample)
}

func (s *Store) Get(conversationKey string) (Item, bool, error) {
	conversationKey = normalizeConversationKey(conversationKey)
	if s == nil || s.stateDir == "" || conversationKey == "" {
		return Item{}, false, nil
	}
	if err := s.migrateLegacy(); err != nil {
		return Item{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var item Item
	found, err := fsstore.ReadJSON(s.itemPath(conversationKey), &item)
	if err != nil || !found {
		return Item{}, false, err
	}
	item, ok := normalizeItem(conversationKey, item)
	return item, ok, nil
}

func (s *Store) UpdateFromSample(scope Scope, sample UsageSample) error {
	scope.ConversationKey = normalizeConversationKey(scope.ConversationKey)
	if s == nil || s.stateDir == "" || scope.ConversationKey == "" || sample.InputTokens <= 0 {
		return nil
	}
	if err := s.migrateLegacy(); err != nil {
		return err
	}
	item := itemFromSample(scope, sample)
	s.mu.Lock()
	defer s.mu.Unlock()
	return fsstore.WithLock(context.Background(), topicstate.LockPath(s.stateDir, scope.ConversationKey), func() error {
		return fsstore.WriteJSONAtomic(s.itemPath(scope.ConversationKey), item, fsstore.FileOptions{})
	})
}

// Delete forgets a conversation's context usage.
func (s *Store) Delete(conversationKey string) error {
	conversationKey = normalizeConversationKey(conversationKey)
	if s == nil || s.stateDir == "" || conversationKey == "" {
		return nil
	}
	if err := s.migrateLegacy(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.itemPath(conversationKey)); err != nil && !os.IsNotExist(err) {
		return err
	}
	topicstate.RemoveIfEmpty(s.stateDir, conversationKey)
	return nil
}

func (s *Store) itemPath(conversationKey string) string {
	return filepath.Join(topicstate.Dir(s.stateDir, conversationKey), contextFileName)
}

// migrateLegacy moves the items of the old shared file into their topic folders, keeping any
// newer item already there, and then removes the old file.
func (s *Store) migrateLegacy() error {
	s.migrateMu.Lock()
	defer s.migrateMu.Unlock()
	if s.migrated || s.path == "" {
		return nil
	}
	if _, err := os.Stat(s.path); os.IsNotExist(err) {
		s.migrated = true
		return nil
	}
	lockPath := s.path + ".lck"
	err := fsstore.WithLock(context.Background(), lockPath, func() error {
		var persisted storeFile
		found, err := fsstore.ReadJSON(s.path, &persisted)
		if err != nil || !found {
			return err
		}
		for key, item := range persisted.Items {
			key = normalizeConversationKey(key)
			item, ok := normalizeItem(key, item)
			if !ok {
				continue
			}
			key = item.ConversationKey
			err := fsstore.WithLock(context.Background(), topicstate.LockPath(s.stateDir, key), func() error {
				if _, err := os.Stat(s.itemPath(key)); err == nil {
					return nil
				}
				return fsstore.WriteJSONAtomic(s.itemPath(key), item, fsstore.FileOptions{})
			})
			if err != nil {
				return err
			}
		}
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("move topic context into topic folders: %w", err)
	}
	_ = os.Remove(lockPath)
	s.migrated = true
	return nil
}

func normalizeItem(key string, item Item) (Item, bool) {
	item.ConversationKey = normalizeConversationKey(item.ConversationKey)
	if item.ConversationKey == "" {
		item.ConversationKey = key
	}
	if item.ConversationKey == "" {
		return Item{}, false
	}
	item.TopicID = strings.TrimSpace(item.TopicID)
	item.Runtime = strings.TrimSpace(item.Runtime)
	item.Model = strings.TrimSpace(item.Model)
	item.NormalizedModel = strings.TrimSpace(item.NormalizedModel)
	item.ContextWindowSource = strings.TrimSpace(item.ContextWindowSource)
	item.LastRunID = strings.TrimSpace(item.LastRunID)
	item.LastOriginEventID = strings.TrimSpace(item.LastOriginEventID)
	item.UpdatedAt = strings.TrimSpace(item.UpdatedAt)
	if item.ContextWindowTokens > 0 && item.UsedInputTokens > 0 {
		item.UsageRatio = float64(item.UsedInputTokens) / float64(item.ContextWindowTokens)
	} else {
		item.UsageRatio = 0
	}
	return item, true
}

func itemFromSample(scope Scope, sample UsageSample) Item {
	windowTokens := sample.ContextWindowTokens
	windowSource := "config"
	normalizedModel := ""
	if entry, ok := llm.ResolveModelContextWindow(sample.Model); ok {
		normalizedModel = entry.NormalizedModel
		if windowTokens <= 0 {
			windowTokens = entry.ContextWindowTokens
			windowSource = "builtin"
		}
	} else if windowTokens <= 0 {
		windowSource = "unknown"
	}
	if normalizedModel == "" {
		normalizedModel = normalizeSampleModel(sample.Model)
	}
	ratio := 0.0
	if windowTokens > 0 {
		ratio = float64(sample.InputTokens) / float64(windowTokens)
	}
	updatedAt := sample.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = time.Now()
	}
	return Item{
		ConversationKey:          normalizeConversationKey(scope.ConversationKey),
		TopicID:                  strings.TrimSpace(scope.TopicID),
		Runtime:                  strings.TrimSpace(scope.Runtime),
		Model:                    strings.TrimSpace(sample.Model),
		NormalizedModel:          normalizedModel,
		ContextWindowTokens:      windowTokens,
		ContextWindowSource:      windowSource,
		UsedInputTokens:          sample.InputTokens,
		CachedInputTokens:        sample.CachedInputTokens,
		CacheCreationInputTokens: sample.CacheCreationInputTokens,
		UsageRatio:               ratio,
		LastRunID:                strings.TrimSpace(sample.RunID),
		LastOriginEventID:        strings.TrimSpace(sample.OriginEventID),
		UpdatedAt:                updatedAt.UTC().Format(time.RFC3339),
	}
}

func shouldTrackScene(scene string) bool {
	scene = strings.TrimSpace(scene)
	if scene == "" {
		return true
	}
	return strings.HasSuffix(scene, ".loop")
}

func normalizeConversationKey(key string) string {
	return strings.TrimSpace(key)
}

func normalizeSampleModel(model string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "models/")
}

func (s *Store) CommandFunc(conversationKey string) func() (string, error) {
	return func() (string, error) {
		return s.RenderCommandText(conversationKey)
	}
}

func (s *Store) RenderCommandText(conversationKey string) (string, error) {
	item, ok, err := s.Get(conversationKey)
	if err != nil {
		return "", err
	}
	if !ok {
		return "No context usage recorded for this topic yet.", nil
	}
	return RenderItemText(item), nil
}

func RenderItemText(item Item) string {
	item.Model = strings.TrimSpace(item.Model)
	if item.Model == "" {
		item.Model = "unknown"
	}
	var out bytes.Buffer
	if err := contextCommandTemplate.Execute(&out, item); err != nil {
		return "Context usage is unavailable."
	}
	return out.String()
}

func formatPercent(ratio float64) string {
	return fmt.Sprintf("%.1f%%", ratio*100)
}

func formatInt64(v int64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	s := fmt.Sprintf("%d", v)
	if len(s) <= 3 {
		return sign + s
	}
	var out []byte
	first := len(s) % 3
	if first == 0 {
		first = 3
	}
	out = append(out, s[:first]...)
	for i := first; i < len(s); i += 3 {
		out = append(out, ',')
		out = append(out, s[i:i+3]...)
	}
	return sign + string(out)
}
