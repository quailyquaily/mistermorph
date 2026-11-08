package topiccontext

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
)

func TestStoreUpdateFromSampleUsesConfiguredWindow(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "topic_context.json"))
	err := store.UpdateFromSample(Scope{ConversationKey: " console:topic-1 ", TopicID: " topic-1 ", Runtime: " console "}, UsageSample{
		Model:               "openai/gpt-5.5",
		ContextWindowTokens: 100,
		InputTokens:         25,
		UpdatedAt:           time.Unix(1, 0),
	})
	if err != nil {
		t.Fatalf("UpdateFromSample() error = %v", err)
	}
	item, ok, err := store.Get(" console:topic-1 ")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok {
		t.Fatalf("Get() found = false, want true")
	}
	if item.ContextWindowTokens != 100 || item.UsageRatio != 0.25 {
		t.Fatalf("item = %+v, want context window 100 and ratio 0.25", item)
	}
	if item.ContextWindowSource != "config" {
		t.Fatalf("context source = %q, want config", item.ContextWindowSource)
	}
	if item.NormalizedModel != "gpt-5.5" {
		t.Fatalf("normalized model = %q, want gpt-5.5", item.NormalizedModel)
	}
}

func TestStoreUpdateFromSampleUsesBuiltinWindow(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "topic_context.json"))
	err := store.UpdateFromSample(Scope{ConversationKey: "k"}, UsageSample{
		Model:       "openai/gpt-5.5",
		InputTokens: 105000,
		UpdatedAt:   time.Unix(1, 0),
	})
	if err != nil {
		t.Fatalf("UpdateFromSample() error = %v", err)
	}
	item, ok, err := store.Get("k")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok {
		t.Fatalf("Get() found = false, want true")
	}
	if item.ContextWindowTokens != 1050000 {
		t.Fatalf("context window = %d, want 1050000", item.ContextWindowTokens)
	}
	if item.ContextWindowSource != "builtin" {
		t.Fatalf("context source = %q, want builtin", item.ContextWindowSource)
	}
}

func TestStoreUpdateFromSampleReplacesPreviousUsage(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "topic_context.json"))
	scope := Scope{ConversationKey: "console:topic-1"}
	if err := store.UpdateFromSample(scope, UsageSample{
		Model:               "gpt-5.5",
		ContextWindowTokens: 10000,
		InputTokens:         1000,
		UpdatedAt:           time.Unix(1, 0),
	}); err != nil {
		t.Fatalf("UpdateFromSample() first error = %v", err)
	}
	if err := store.UpdateFromSample(scope, UsageSample{
		Model:               "gpt-5.5",
		ContextWindowTokens: 10000,
		InputTokens:         1300,
		CachedInputTokens:   300,
		UpdatedAt:           time.Unix(2, 0),
	}); err != nil {
		t.Fatalf("UpdateFromSample() second error = %v", err)
	}

	item, ok, err := store.Get("console:topic-1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok {
		t.Fatalf("Get() found = false, want true")
	}
	if item.UsedInputTokens != 1300 {
		t.Fatalf("used input tokens = %d, want 1300", item.UsedInputTokens)
	}
	if item.CachedInputTokens != 300 {
		t.Fatalf("cached input tokens = %d, want 300", item.CachedInputTokens)
	}
	if item.UsageRatio < 0.129 || item.UsageRatio > 0.131 {
		t.Fatalf("usage ratio = %v, want about 0.13", item.UsageRatio)
	}
}

func TestShouldTrackSceneOnlyTracksLoops(t *testing.T) {
	tests := []struct {
		scene string
		want  bool
	}{
		{scene: "console.loop", want: true},
		{scene: "telegram.loop", want: true},
		{scene: "awareness.cron", want: true},
		{scene: "awareness.heartbeat", want: false},
		{scene: "telegram.context_compact", want: false},
		{scene: "settings.benchmark", want: false},
		{scene: "addressing.classify", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.scene, func(t *testing.T) {
			if got := shouldTrackScene(tc.scene); got != tc.want {
				t.Fatalf("shouldTrackScene(%q) = %v, want %v", tc.scene, got, tc.want)
			}
		})
	}
}

func TestRenderItemTextUsesMarkdownList(t *testing.T) {
	got := RenderItemText(Item{
		Model:               "gpt-5.5",
		ContextWindowTokens: 1050000,
		UsedInputTokens:     123456,
		CachedInputTokens:   23456,
		UsageRatio:          0.117577,
		UpdatedAt:           "2026-05-22T00:00:00Z",
	})
	want := "**Context**\n\n" +
		"- **Window used:** 11.8%\n" +
		"- **Used input:** 123,456 / 1,050,000 tokens\n" +
		"- **Cached input:** 23,456 tokens\n" +
		"- **Model:** gpt-5.5\n" +
		"- **Updated:** 2026-05-22T00:00:00Z"
	if got != want {
		t.Fatalf("RenderItemText() = %q, want %q", got, want)
	}
}

func TestRenderItemTextHandlesUnknownWindow(t *testing.T) {
	got := RenderItemText(Item{
		UsedInputTokens: 42,
		UpdatedAt:       "2026-05-22T00:00:00Z",
	})
	want := "**Context**\n\n" +
		"- **Window used:** unknown\n" +
		"- **Used input:** 42 tokens\n" +
		"- **Context window:** unknown\n" +
		"- **Model:** unknown\n" +
		"- **Updated:** 2026-05-22T00:00:00Z"
	if got != want {
		t.Fatalf("RenderItemText() = %q, want %q", got, want)
	}
}

func TestStoreConcurrentWritesKeepItems(t *testing.T) {
	path := filepath.Join(t.TempDir(), "topic_context.json")
	const count = 8
	var wg sync.WaitGroup
	errs := make(chan error, count)
	for i := 0; i < count; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			store := NewStore(path)
			errs <- store.UpdateFromSample(Scope{ConversationKey: fmt.Sprintf("console:topic-%d", i)}, UsageSample{
				Model:       "gpt-5.5",
				InputTokens: int64(100 + i),
				UpdatedAt:   time.Unix(int64(i+1), 0),
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("UpdateFromSample() error = %v", err)
		}
	}

	store := NewStore(path)
	for i := 0; i < count; i++ {
		key := fmt.Sprintf("console:topic-%d", i)
		item, ok, err := store.Get(key)
		if err != nil {
			t.Fatalf("Get(%q) error = %v", key, err)
		}
		if !ok {
			t.Fatalf("Get(%q) found = false, want true", key)
		}
		if item.UsedInputTokens != int64(100+i) {
			t.Fatalf("Get(%q).used = %d, want %d", key, item.UsedInputTokens, 100+i)
		}
	}
}

func TestStoreImportsTheLegacyFileAndTopicFolders(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "topic_context.json")
	raw := `{"version":1,"items":{"console:a":{"conversation_key":"console:a","model":"m","context_window_tokens":1000,"used_input_tokens":250},` +
		`"console:b":{"conversation_key":"console:b","model":"old","used_input_tokens":1}}}`
	if err := os.WriteFile(legacy, []byte(raw), 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}
	writeTopicFile := func(key, name, content string) {
		t.Helper()
		dir := filepath.Join(root, "topics", topicstate.Key(key))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A topic folder's own file is newer than the shared file and wins.
	writeTopicFile("console:b", "context.json", `{"conversation_key":"console:b","topic_id":"b","runtime":"console","model":"new",`+
		`"normalized_model":"new","context_window_tokens":2000,"context_window_source":"builtin","used_input_tokens":500,`+
		`"cached_input_tokens":7,"cache_creation_input_tokens":3,"last_run_id":"r","last_origin_event_id":"e","updated_at":"2026-01-02T03:04:05Z"}`)
	writeTopicFile("console:b", "context_snapshot.json", `{"conversation_key":"console:b","topic_id":"b","captured_at":"2026-01-02T03:04:05Z","input_tokens":500,"method":"estimate","parts":[]}`)
	writeTopicFile("console:b", "context_request.json", `{"captured_at":"2026-01-02T03:04:05Z","messages":[{"role":"user","content":"hi"}]}`)
	writeTopicFile("console:b", "context_checkpoint.json", `{"kept":"as a file"}`)
	writeTopicFile("console:c", "context.json", `not json`)

	store := NewStore(legacy)
	item, ok, err := store.Get("console:a")
	if err != nil || !ok {
		t.Fatalf("Get() ok=%v err=%v", ok, err)
	}
	if item.UsedInputTokens != 250 || item.UsageRatio != 0.25 {
		t.Fatalf("item = %+v", item)
	}
	b, ok, err := store.Get("console:b")
	if err != nil || !ok {
		t.Fatalf("Get(b) ok=%v err=%v", ok, err)
	}
	want := Item{ConversationKey: "console:b", TopicID: "b", Runtime: "console", Model: "new", NormalizedModel: "new",
		ContextWindowTokens: 2000, ContextWindowSource: "builtin", UsedInputTokens: 500, CachedInputTokens: 7,
		CacheCreationInputTokens: 3, UsageRatio: 0.25, LastRunID: "r", LastOriginEventID: "e", UpdatedAt: "2026-01-02T03:04:05Z"}
	if b != want {
		t.Fatalf("item b = %+v\nwant %+v", b, want)
	}
	snapshot, ok, err := store.Snapshot("console:b")
	if err != nil || !ok || snapshot.InputTokens != 500 {
		t.Fatalf("snapshot = %+v, %v, %v", snapshot, ok, err)
	}
	var stored storedRequest
	if found, err := store.readStoredRequest("console:b", &stored); err != nil || !found || stored.Messages[0].Content != "hi" {
		t.Fatalf("stored request = %+v, %v, %v", stored, found, err)
	}
	if _, err := os.Stat(legacy + ".imported"); err != nil {
		t.Fatalf("legacy file not renamed: %v", err)
	}
	dirB := filepath.Join(root, "topics", topicstate.Key("console:b"))
	for _, name := range []string{"context.json", "context_snapshot.json", "context_request.json"} {
		if _, err := os.Stat(filepath.Join(dirB, name+".imported")); err != nil {
			t.Fatalf("%s not renamed: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dirB, "context_checkpoint.json")); err != nil {
		t.Fatalf("checkpoint moved: %v", err)
	}
	db, err := store.handle()
	if err != nil {
		t.Fatal(err)
	}
	rejects, err := agentdb.Rejects(context.Background(), db, "topic_state")
	if err != nil || rejects.Count != 1 || !strings.HasSuffix(rejects.Rejects[0].Source, "/context.json") {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}
	if err := store.Delete("console:a"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, ok, _ := store.Get("console:a"); ok {
		t.Fatalf("item still there after Delete()")
	}
	// Removing a topic deletes its rows and its folder.
	if err := topicstate.Remove(root, "console:b"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := store.Get("console:b"); ok {
		t.Fatal("context row left after Remove")
	}
	if _, ok, _ := store.Snapshot("console:b"); ok {
		t.Fatal("snapshot row left after Remove")
	}
	if _, err := os.Stat(dirB); !os.IsNotExist(err) {
		t.Fatalf("topic folder left after Remove: %v", err)
	}
}
