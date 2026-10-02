package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

func TestSetTopicTagsSurvivesReloadAndKeepsTheTopicOrder(t *testing.T) {
	root := t.TempDir()
	opts := ConsoleFileStoreOptions{RootDir: root, JournalDir: filepath.Join(root, "journal"), Persist: true}
	store, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	topic, err := store.CreateTopic("seed")
	if err != nil {
		t.Fatal(err)
	}
	tagged, err := store.SetTopicTags(topic.ID, []string{" Work ", "work", "side   project", ""})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(tagged.Tags, ",") != "Work,side project" || !tagged.UpdatedAt.Equal(topic.UpdatedAt) {
		t.Fatalf("tagged = %+v", tagged)
	}
	// A later task keeps the tags on the topic.
	if err := store.Upsert(TaskInfo{ID: "task", TopicID: topic.ID, Task: "hello"}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := reloaded.GetTopic(topic.ID)
	if got == nil || strings.Join(got.Tags, ",") != "Work,side project" {
		t.Fatalf("reloaded topic = %+v", got)
	}
	if _, err := reloaded.SetTopicTags(topic.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := reloaded.GetTopic(topic.ID); len(got.Tags) != 0 {
		t.Fatalf("tags not cleared: %+v", got)
	}
	if _, err := reloaded.SetTopicTags(topic.ID, []string{strings.Repeat("x", 33)}); err == nil {
		t.Fatal("a 33-character tag was accepted")
	}
	if _, err := reloaded.SetTopicTags("missing", []string{"a"}); err != ErrTopicNotFound {
		t.Fatalf("unknown topic: %v", err)
	}
}

func TestTopicTagsRoute(t *testing.T) {
	store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
	topic, _ := store.CreateTopic("seed")
	for _, tt := range []struct {
		name, method, id, body string
		unavailable            bool
		status                 int
	}{
		{"set", http.MethodPut, topic.ID, `{"tags":["Work","Ideas"]}`, false, 200},
		{"wrong method", http.MethodPost, topic.ID, `{"tags":[]}`, false, 405},
		{"unknown topic", http.MethodPut, "missing", `{"tags":["a"]}`, false, 404},
		{"too many", http.MethodPut, topic.ID, `{"tags":["1","2","3","4","5","6"]}`, false, 400},
		{"bad json", http.MethodPut, topic.ID, `{`, false, 400},
		{"unavailable", http.MethodPut, topic.ID, `{"tags":[]}`, true, 503},
	} {
		t.Run(tt.name, func(t *testing.T) {
			opts := RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{TopicReader: store}}
			if !tt.unavailable {
				opts.TaskTopic.SetTopicTags = store.SetTopicTags
			}
			req := httptest.NewRequest(tt.method, "/topics/"+tt.id+"/tags", strings.NewReader(tt.body))
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			NewHandler(opts).ServeHTTP(rec, req)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tt.status, rec.Body.String())
			}
			if tt.status == 200 {
				var got TopicInfo
				_ = json.Unmarshal(rec.Body.Bytes(), &got)
				if strings.Join(got.Tags, ",") != "Work,Ideas" {
					t.Fatalf("response = %+v", got)
				}
			}
		})
	}
}

func TestTopicContextRoute(t *testing.T) {
	snapshot := topiccontext.Snapshot{ConversationKey: "console:t1", InputTokens: 900, Method: topiccontext.MethodEstimate}
	for _, tt := range []struct {
		name, path  string
		unavailable bool
		status      int
	}{
		{"snapshot", "/topic/t1/context", false, 200},
		{"nested topic path", "/topic/a/b/context", false, 400},
		{"unavailable", "/topic/t1/context", true, 503},
	} {
		t.Run(tt.name, func(t *testing.T) {
			opts := RoutesOptions{AuthToken: "token"}
			if !tt.unavailable {
				opts.TaskTopic.TopicContext = func(_ context.Context, topicID string) (TopicContext, error) {
					return TopicContext{Available: true, Snapshot: &snapshot, CompactionTriggerTokens: 700}, nil
				}
			}
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			NewHandler(opts).ServeHTTP(rec, req)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tt.status, rec.Body.String())
			}
			if tt.status == 200 && (!strings.Contains(rec.Body.String(), `"input_tokens":900`) || !strings.Contains(rec.Body.String(), `"compaction_trigger_tokens":700`)) {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}
