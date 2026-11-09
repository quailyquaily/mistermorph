package topiccontext

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
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

// Store keeps each conversation's context use and latest request snapshot in agent.db
// (topic_contexts and topic_context_snapshots), keyed by the conversation key. path names the old
// shared file, topic_context.json in the state folder; agent.db is beside it.
type Store struct {
	path     string
	stateDir string
	db       *agentdb.Lazy
}

func NewStore(path string) *Store {
	path = strings.TrimSpace(path)
	stateDir := ""
	if path != "" {
		stateDir = filepath.Dir(path)
	}
	store := &Store{path: path, stateDir: stateDir}
	if stateDir != "" {
		store.db = agentdb.NewLazy(filepath.Join(stateDir, statepaths.AgentDBFilename))
	}
	return store
}

func (s *Store) handle() (*agentdb.DB, error) {
	return s.db.Get(context.Background())
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
	db, err := s.handle()
	if err != nil {
		return Item{}, false, err
	}
	var item Item
	err = db.QueryRowContext(context.Background(), `SELECT conversation_key, topic_id, runtime, model, normalized_model,
		context_window_tokens, context_window_source, used_input_tokens, cached_input_tokens, cache_creation_input_tokens,
		usage_ratio, last_run_id, last_origin_event_id, updated_at FROM topic_contexts WHERE conversation_key = ?`, conversationKey).
		Scan(&item.ConversationKey, &item.TopicID, &item.Runtime, &item.Model, &item.NormalizedModel, &item.ContextWindowTokens,
			&item.ContextWindowSource, &item.UsedInputTokens, &item.CachedInputTokens, &item.CacheCreationInputTokens,
			&item.UsageRatio, &item.LastRunID, &item.LastOriginEventID, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, false, nil
	}
	if err != nil {
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
	item := itemFromSample(scope, sample)
	db, err := s.handle()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(context.Background(), `INSERT INTO topic_contexts (conversation_key, topic_id, runtime, model,
		normalized_model, context_window_tokens, context_window_source, used_input_tokens, cached_input_tokens,
		cache_creation_input_tokens, usage_ratio, last_run_id, last_origin_event_id, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (conversation_key) DO UPDATE SET topic_id = excluded.topic_id, runtime = excluded.runtime,
		model = excluded.model, normalized_model = excluded.normalized_model,
		context_window_tokens = excluded.context_window_tokens, context_window_source = excluded.context_window_source,
		used_input_tokens = excluded.used_input_tokens, cached_input_tokens = excluded.cached_input_tokens,
		cache_creation_input_tokens = excluded.cache_creation_input_tokens, usage_ratio = excluded.usage_ratio,
		last_run_id = excluded.last_run_id, last_origin_event_id = excluded.last_origin_event_id,
		updated_at = excluded.updated_at`,
		item.ConversationKey, item.TopicID, item.Runtime, item.Model, item.NormalizedModel, item.ContextWindowTokens,
		item.ContextWindowSource, item.UsedInputTokens, item.CachedInputTokens, item.CacheCreationInputTokens,
		item.UsageRatio, item.LastRunID, item.LastOriginEventID, item.UpdatedAt)
	return err
}

// Delete forgets a conversation's context usage.
func (s *Store) Delete(conversationKey string) error {
	conversationKey = normalizeConversationKey(conversationKey)
	if s == nil || s.stateDir == "" || conversationKey == "" {
		return nil
	}
	db, err := s.handle()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(context.Background(), `DELETE FROM topic_contexts WHERE conversation_key = ?`, conversationKey)
	return err
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
	// A TODO item's run is the agent loop of that item's topic. Only a run with a scope is recorded.
	return strings.HasSuffix(scene, ".loop") || scene == "awareness.cron"
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
