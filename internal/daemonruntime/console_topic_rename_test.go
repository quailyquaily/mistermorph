package daemonruntime

import (
	"bytes"
	"context"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenameTopicPersistsAndBlocksAutomaticNaming(t *testing.T) {
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
	if err := store.SetTopicTitleFromLLM(topic.ID, "seed", "generated", "code"); err != nil {
		t.Fatal(err)
	}
	named, _ := store.GetTopic(topic.ID)
	// A regeneration that started before the rename must not land after it.
	started, err := store.BeginTopicTitleRegeneration(topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := store.RenameTopic(topic.ID, "  My\n  trip   plans ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "My trip plans" || !renamed.TitleCustomized || renamed.TitleRevision <= started.TitleRevision || renamed.Icon != named.Icon {
		t.Fatalf("renamed = %+v", renamed)
	}
	if _, err := store.CompleteTopicTitleRegeneration(topic.ID, started.TitleRevision, "late", "baby"); !errors.Is(err, ErrTopicTitleChanged) {
		t.Fatalf("late regeneration error = %v", err)
	}
	if err := store.SetTopicTitleFromLLM(topic.ID, "My trip plans", "late auto name", "baby"); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := reloaded.GetTopic(topic.ID)
	if got.Title != "My trip plans" || got.Icon != "code" || !got.TitleCustomized {
		t.Fatalf("reloaded = %+v", got)
	}
	page := reloaded.ListTopicsPage(TopicListOptions{Limit: 10})
	if len(page) == 0 || page[0].Title != "My trip plans" {
		t.Fatalf("list = %+v", page)
	}
}

func TestRenameTopicFirstNamingRejectsLateResult(t *testing.T) {
	store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
	topic, _ := store.CreateNamedTopic("")
	if _, err := store.RenameTopic(topic.ID, "Mine"); err != nil {
		t.Fatal(err)
	}
	// The first message's naming read the empty title before the rename.
	if err := store.SetTopicTitleFromLLM(topic.ID, "", "generated", "code"); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetTopic(topic.ID); got.Title != "Mine" || got.Icon != "" || got.LLMTitleGeneratedAt != nil {
		t.Fatalf("topic = %+v", got)
	}
}

func TestRenameTopicRejects(t *testing.T) {
	store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
	topic, _ := store.CreateTopic("seed")
	if err := store.UpsertWithTrigger(TaskInfo{ID: "run", TopicID: CronTopicID("weekly"), Task: "report"}, TaskTrigger{}, "Weekly report"); err != nil {
		t.Fatal(err)
	}
	gone, _ := store.CreateTopic("gone")
	if _, err := store.DeleteTopic(gone.ID); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, id, title string
		notFound        bool
	}{
		{"blank", topic.ID, " \n\t ", false},
		{"too long", topic.ID, strings.Repeat("猫", TopicTitleMaxRunes+1), false},
		{"default", ConsoleDefaultTopicID, "x", false},
		{"awareness", ConsoleAwarenessTopicID, "x", false},
		{"todo item", CronTopicID("weekly"), "x", false},
		{"agent", AgentLinkTopicID("a"), "x", false},
		{"missing", "nope", "x", true},
		{"deleted", gone.ID, "x", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := store.RenameTopic(tt.id, tt.title)
			if tt.notFound {
				if !errors.Is(err, ErrTopicNotFound) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if _, ok := badRequestMessage(err); !ok {
				t.Fatalf("error = %v, want a bad request", err)
			}
		})
	}
	if got, _ := store.GetTopic(topic.ID); got.Title != "seed" || got.TitleRevision != 0 {
		t.Fatalf("rejected rename changed the topic: %+v", got)
	}
	if got, _ := store.GetTopic(CronTopicID("weekly")); got.Title != "Weekly report" {
		t.Fatalf("TODO item's topic renamed: %+v", got)
	}
	if _, err := store.RenameTopic(topic.ID, strings.Repeat("猫", TopicTitleMaxRunes)); err != nil {
		t.Fatalf("full-length title: %v", err)
	}
}

func TestTopicTitleRoutes(t *testing.T) {
	for _, tt := range []struct {
		name, method, path, body, token string
		unavailable                     bool
		fail                            error
		status                          int
		want                            string
	}{
		{name: "rename", method: "PUT", path: "/topics/topic_a/title", body: `{"title":"  Mine "}`, status: 200, want: `"title":"Mine"`},
		{name: "rename auth", method: "PUT", path: "/topics/topic_a/title", body: `{"title":"Mine"}`, token: "wrong", status: 401},
		{name: "rename method", method: "POST", path: "/topics/topic_a/title", body: `{"title":"Mine"}`, status: 405},
		{name: "rename blank", method: "PUT", path: "/topics/topic_a/title", body: `{"title":"  "}`, status: 400},
		{name: "rename invalid json", method: "PUT", path: "/topics/topic_a/title", body: `{`, status: 400},
		{name: "rename missing", method: "PUT", path: "/topics/nope/title", body: `{"title":"Mine"}`, status: 404},
		{name: "rename todo item", method: "PUT", path: "/topics/_cron_weekly/title", body: `{"title":"Mine"}`, status: 400},
		{name: "rename default", method: "PUT", path: "/topics/default/title", body: `{"title":"Mine"}`, status: 400},
		{name: "rename unavailable", method: "PUT", path: "/topics/topic_a/title", body: `{"title":"Mine"}`, unavailable: true, status: 503},
		{name: "suggest", method: "POST", path: "/topics/topic_a/title-suggestion", status: 200, want: `"title":"Suggested"`},
		{name: "suggest method", method: "GET", path: "/topics/topic_a/title-suggestion", status: 405},
		{name: "suggest missing", method: "POST", path: "/topics/nope/title-suggestion", status: 404},
		{name: "suggest todo item", method: "POST", path: "/topics/_cron_weekly/title-suggestion", status: 400},
		{name: "suggest empty", method: "POST", path: "/topics/topic_a/title-suggestion", fail: BadRequest("topic has no conversation to name"), status: 400},
		{name: "suggest busy", method: "POST", path: "/topics/topic_a/title-suggestion", fail: ErrTopicTitleBusy, status: 409},
		{name: "suggest failed", method: "POST", path: "/topics/topic_a/title-suggestion", fail: errors.New("offline"), status: 503},
		{name: "suggest unavailable", method: "POST", path: "/topics/topic_a/title-suggestion", unavailable: true, status: 503},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := NewConsoleFileStore(ConsoleFileStoreOptions{})
			if err := store.Upsert(TaskInfo{ID: "task", TopicID: "topic_a", Task: "hello"}); err != nil {
				t.Fatal(err)
			}
			if err := store.Upsert(TaskInfo{ID: "run", TopicID: "_cron_weekly", Task: "report"}); err != nil {
				t.Fatal(err)
			}
			before, _ := store.GetTopic("topic_a")
			suggestCalls := 0
			opts := RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{TopicReader: store}}
			if !tt.unavailable {
				opts.TaskTopic.SetTopicTitle = store.RenameTopic
				opts.TaskTopic.SuggestTopicTitle = func(_ context.Context, id string) (TopicTitleSuggestion, error) {
					suggestCalls++
					return TopicTitleSuggestion{Title: "Suggested", Icon: "code"}, tt.fail
				}
			}
			token := tt.token
			if token == "" {
				token = "token"
			}
			req := httptest.NewRequest(tt.method, tt.path, bytes.NewBufferString(tt.body))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			NewHandler(opts).ServeHTTP(rec, req)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			if tt.want != "" && !strings.Contains(rec.Body.String(), tt.want) {
				t.Fatal(rec.Body.String())
			}
			got, _ := store.GetTopic("topic_a")
			if strings.HasSuffix(tt.path, "/title-suggestion") {
				if got.Title != before.Title || got.TitleRevision != before.TitleRevision || got.Icon != before.Icon {
					t.Fatalf("a suggestion changed the topic: %+v", got)
				}
				if tt.status == 404 || tt.status == 405 || (tt.status == 400 && tt.fail == nil) {
					if suggestCalls != 0 {
						t.Fatal("generated for a refused request")
					}
				}
			} else if tt.status != 200 && got.Title != before.Title {
				t.Fatalf("refused rename changed the topic: %+v", got)
			}
		})
	}
}
