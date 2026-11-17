package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/contextcheckpoint"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/spf13/viper"
)

// Editing a message through the Console runtime: the edited message and everything after it leave
// the topic for good (the store, a reload, the next run's prompt), the replacement runs with the
// earlier conversation alone, and a refused edit leaves the conversation as it was.

type editRuntimeFixture struct {
	rt         *consoleLocalRuntime
	store      *daemonruntime.ConsoleFileStore
	stateRoot  string
	journalDir string
	cacheDir   string
	topicID    string
	tasks      map[string]daemonruntime.TaskInfo
}

func newEditRuntimeFixture(t *testing.T) *editRuntimeFixture {
	t.Helper()
	f := &editRuntimeFixture{stateRoot: t.TempDir(), cacheDir: t.TempDir(), tasks: map[string]daemonruntime.TaskInfo{}}
	f.journalDir = filepath.Join(f.stateRoot, "journal")
	f.store = f.openStore(t)
	bus, err := busruntime.NewInproc(busruntime.InprocOptions{MaxInFlight: 4, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bus.Close() })
	// The runs are not started: each test takes its job from the pending jobs.
	if err := bus.Subscribe(busruntime.TopicChatMessage, func(context.Context, busruntime.BusMessage) error { return nil }); err != nil {
		t.Fatal(err)
	}
	reader := viper.New()
	reader.Set("timeout", time.Minute)
	reader.Set("file_cache_dir", f.cacheDir)
	generation := &consoleLocalRuntimeGeneration{
		reader:     reader,
		logger:     slog.Default(),
		commonDeps: depsutilDepsForEdit(),
	}
	f.rt = &consoleLocalRuntime{
		store:                 f.store,
		bus:                   bus,
		generation:            generation,
		consoleExecutionState: newConsoleExecutionState(nil, nil),
		workspaceStore:        workspace.NewStore(filepath.Join(t.TempDir(), "workspace_attachments.json")),
	}
	topic, err := f.store.CreateTopic("Foxes")
	if err != nil {
		t.Fatal(err)
	}
	f.topicID = topic.ID
	if err := os.WriteFile(filepath.Join(f.cacheDir, "fox.png"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Hour)
	for i, turn := range []struct{ id, question, answer string }{
		{"t1", "What is a fox?", "A small wild canid."},
		{"t2", "Name a fox in this picture", "That fox is Rin."},
		{"t3", "Make it shorter", "Short: a fox called Rin."},
	} {
		created := base.Add(time.Duration(i) * time.Minute)
		finished := created.Add(30 * time.Second)
		info := daemonruntime.TaskInfo{
			ID: turn.id, Status: daemonruntime.TaskDone, Task: turn.question, CreatedAt: created, FinishedAt: &finished, TopicID: topic.ID,
			Result: map[string]any{"final": map[string]any{"output": turn.answer}},
		}
		if turn.id == "t2" {
			info.FileReferences = []daemonruntime.FileReference{{DirName: "file_cache_dir", Path: "fox.png"}}
		}
		if err := f.store.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}, ""); err != nil {
			t.Fatal(err)
		}
		f.tasks[turn.id] = info
	}
	return f
}

func depsutilDepsForEdit() (deps depsutil.CommonDependencies) {
	deps.ResolveLLMRoute = func(purpose string) (llmutil.ResolvedRoute, error) {
		return llmutil.ResolvedRoute{Purpose: purpose, ClientConfig: llmconfig.ClientConfig{Provider: "test", Model: "main-model"}}, nil
	}
	return deps
}

func (f *editRuntimeFixture) openStore(t *testing.T) *daemonruntime.ConsoleFileStore {
	t.Helper()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
		RootDir: filepath.Join(f.stateRoot, "tasks", "console"), Persist: true, JournalDir: f.journalDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// replace edits as the route does: with a generation it holds until the run takes it over.
func (f *editRuntimeFixture) replace(t *testing.T, target, text string) (daemonruntime.ReplaceTaskResponse, consoleLocalTaskJob, error) {
	t.Helper()
	generation, err := f.rt.captureGeneration()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := f.rt.replaceTaskWithGeneration(context.Background(), generation, daemonruntime.ReplaceTaskRequest{
		TaskID: target, TopicID: f.topicID, Task: text,
		Trigger: &daemonruntime.TaskTrigger{Source: "ui", Event: "chat_edit", Ref: consoleChatTriggerRef},
	})
	if err != nil {
		return resp, consoleLocalTaskJob{}, err
	}
	job, ok := f.rt.takePendingJob(resp.ID)
	if !ok {
		t.Fatalf("no pending job for %s", resp.ID)
	}
	if job.Generation != nil {
		job.Generation.release()
	}
	return resp, job, nil
}

func (f *editRuntimeFixture) topicTexts(store *daemonruntime.ConsoleFileStore) []string {
	items := store.List(daemonruntime.TaskListOptions{TopicID: f.topicID, Limit: 50})
	out := []string{}
	for i := len(items) - 1; i >= 0; i-- {
		out = append(out, items[i].Task)
	}
	return out
}

// The text of each prompt message, in order.
func messageTexts(messages []llm.Message) []string {
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		out = append(out, message.Role+": "+message.Content)
	}
	return out
}

func TestConsoleEditMessageReplacesTheRestOfTheTopic(t *testing.T) {
	for _, tc := range []struct {
		name, target string
		kept         []string
	}{
		{"latest message", "t3", []string{"t1", "t2"}},
		{"earlier message", "t2", []string{"t1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEditRuntimeFixture(t)
			resp, job, err := f.replace(t, tc.target, "  What does a fox eat?  ")
			if err != nil {
				t.Fatalf("replace error = %v", err)
			}
			if resp.ReplacedTaskID != tc.target || resp.TopicID != f.topicID || resp.Status != daemonruntime.TaskQueued {
				t.Fatalf("response = %+v", resp)
			}
			wantTexts := []string{}
			for _, id := range tc.kept {
				wantTexts = append(wantTexts, f.tasks[id].Task)
			}
			wantTexts = append(wantTexts, "What does a fox eat?")
			if got := f.topicTexts(f.store); !reflect.DeepEqual(got, wantTexts) {
				t.Fatalf("topic = %v, want %v", got, wantTexts)
			}
			// The edited message keeps the files it carried.
			stored, _ := f.store.Get(resp.ID)
			wantFiles := f.tasks[tc.target].FileReferences
			if !reflect.DeepEqual(stored.FileReferences, wantFiles) || !reflect.DeepEqual(job.FileReferences, wantFiles) {
				t.Fatalf("files = %+v / %+v, want %+v", stored.FileReferences, job.FileReferences, wantFiles)
			}
			if trigger, _ := f.store.GetTrigger(resp.ID); trigger.Event != "chat_edit" || trigger.Ref != consoleChatTriggerRef {
				t.Fatalf("trigger = %+v", trigger)
			}

			// The run's prompt: exactly the conversation before the edited message, then the edit.
			reference := &consoleLocalRuntime{store: f.referenceStore(t, tc.kept)}
			for name, store := range map[string]*daemonruntime.ConsoleFileStore{"live": f.store, "reloaded": f.openStore(t)} {
				rt := &consoleLocalRuntime{store: store}
				history, current, err := renderConsolePromptMessages(rt.loadConsoleRunHistory(job), job, "main-model", nil, nil, slog.Default())
				if err != nil {
					t.Fatal(err)
				}
				wantHistory, _, err := renderConsolePromptMessages(reference.loadConsoleRunHistory(job), job, "main-model", nil, nil, slog.Default())
				if err != nil {
					t.Fatal(err)
				}
				if got, want := messageTexts(history), messageTexts(wantHistory); !reflect.DeepEqual(got, want) {
					t.Fatalf("%s prompt history =\n%v\nwant\n%v", name, got, want)
				}
				joined := strings.Join(messageTexts(history), "\n")
				for _, id := range []string{"t1", "t2", "t3"} {
					kept := false
					for _, k := range tc.kept {
						kept = kept || k == id
					}
					answer := f.tasks[id].Result.(map[string]any)["final"].(map[string]any)["output"].(string)
					if strings.Contains(joined, answer) != kept {
						t.Fatalf("%s prompt history has %s's answer = %v, want %v:\n%s", name, id, !kept, kept, joined)
					}
				}
				if current == nil || !strings.Contains(current.Content, "What does a fox eat?") || strings.Contains(current.Content, f.tasks[tc.target].Task) {
					t.Fatalf("%s current message = %+v", name, current)
				}
				if got := f.topicTexts(store); !reflect.DeepEqual(got, wantTexts) {
					t.Fatalf("%s topic = %v, want %v", name, got, wantTexts)
				}
			}
		})
	}
}

// A store holding only the kept turns: the prompt a fresh topic with that conversation would get.
func (f *editRuntimeFixture) referenceStore(t *testing.T, kept []string) *daemonruntime.ConsoleFileStore {
	t.Helper()
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateTopic("Foxes"); err != nil {
		t.Fatal(err)
	}
	for _, id := range kept {
		if err := store.Upsert(f.tasks[id]); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

// A context checkpoint that summarized a dropped turn is let go by the replacement's run; one that
// summarized only the kept conversation stays.
func TestConsoleEditMessageLetsGoOfACheckpointOverDroppedTurns(t *testing.T) {
	for _, tc := range []struct {
		name, coveredBy string
		kept            bool
	}{
		{"covers a dropped turn", "t3", false},
		{"covers the kept turns", "t1", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEditRuntimeFixture(t)
			root := t.TempDir()
			key := buildConsoleConversationKey(f.topicID)
			outbound, ok := chathistory.TaskOutbound(f.tasks[tc.coveredBy])
			if !ok {
				t.Fatal("no outbound item")
			}
			checkpoints, err := contextcheckpoint.NewFileStore(root, key)
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			if err := checkpoints.Save(context.Background(), 0, agent.ContextCheckpoint{
				Version: 1, Revision: 1, CoveredThrough: chathistory.BoundaryForItem(outbound),
				Message: llm.Message{Role: "user", Content: "Summary of the conversation so far."}, CreatedAt: now, UpdatedAt: now,
			}); err != nil {
				t.Fatal(err)
			}
			_, job, err := f.replace(t, "t2", "What does a fox eat?")
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := contextcheckpoint.PrepareHistory(context.Background(), root, key, f.rt.loadConsoleRunHistory(job), newConsoleInboundHistoryItem(job))
			if err != nil {
				t.Fatal(err)
			}
			_, found, err := checkpoints.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if found != tc.kept {
				t.Fatalf("checkpoint kept = %v, want %v", found, tc.kept)
			}
			for _, item := range prepared.History {
				if strings.Contains(item.Text, "Rin") || strings.Contains(item.Text, "Make it shorter") {
					t.Fatalf("prepared history holds a dropped turn: %+v", item)
				}
			}
		})
	}
}

func TestConsoleEditMessageRefusalsKeepTheConversation(t *testing.T) {
	original := []string{"What is a fox?", "Name a fox in this picture", "Make it shorter"}
	for _, tc := range []struct {
		name, target, text string
		setup              func(t *testing.T, f *editRuntimeFixture)
		check              func(error) bool
	}{
		{name: "a reply under way", target: "t2", text: "edited", setup: func(t *testing.T, f *editRuntimeFixture) {
			running := daemonruntime.TaskInfo{ID: "t4", Status: daemonruntime.TaskRunning, Task: "And another?", CreatedAt: time.Now().UTC(), TopicID: f.topicID}
			if err := f.store.Upsert(running); err != nil {
				t.Fatal(err)
			}
		}, check: func(err error) bool { return errors.Is(err, daemonruntime.ErrTopicRunning) }},
		{name: "unknown message", target: "nope", text: "edited", check: func(err error) bool { return errors.Is(err, daemonruntime.ErrMessageNotFound) }},
		{name: "edited into a command", target: "t2", text: "/reset", check: errorSays("edited into a command")},
		{name: "a command", target: "t3", text: "edited", setup: func(t *testing.T, f *editRuntimeFixture) {
			if err := f.store.Update("t3", func(info *daemonruntime.TaskInfo) { info.Task = "/model" }); err != nil {
				t.Fatal(err)
			}
		}, check: errorSays("a command can't be edited")},
		{name: "a file gone from the cache", target: "t2", text: "edited", setup: func(t *testing.T, f *editRuntimeFixture) {
			if err := os.Remove(filepath.Join(f.cacheDir, "fox.png")); err != nil {
				t.Fatal(err)
			}
		}, check: errorSays("file does not exist")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEditRuntimeFixture(t)
			if tc.setup != nil {
				tc.setup(t, f)
			}
			before := f.topicTexts(f.store)
			if _, _, err := f.replace(t, tc.target, tc.text); err == nil || !tc.check(err) {
				t.Fatalf("replace error = %v", err)
			}
			if got := f.topicTexts(f.store); !reflect.DeepEqual(got, before) {
				t.Fatalf("topic after refusal = %v, want %v", got, before)
			}
			if got := f.topicTexts(f.openStore(t)); !reflect.DeepEqual(got, before) {
				t.Fatalf("reloaded topic after refusal = %v, want %v", got, before)
			}
			if tc.setup == nil && !reflect.DeepEqual(before, original) {
				t.Fatalf("fixture topic = %v", before)
			}
		})
	}

	t.Run("a topic of an Agent Link agent, of a TODO item, or none", func(t *testing.T) {
		f := newEditRuntimeFixture(t)
		for _, topicID := range []string{daemonruntime.AgentLinkTopicID("peer"), daemonruntime.CronTopicID("weekly"), daemonruntime.ConsoleAwarenessTopicID, "", "no-such-topic"} {
			generation, err := f.rt.captureGeneration()
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.rt.replaceTaskWithGeneration(context.Background(), generation, daemonruntime.ReplaceTaskRequest{TaskID: "t2", TopicID: topicID, Task: "edited"})
			if err == nil || !(errorSays("can't be edited")(err) || errorSays("missing topic_id")(err) || errors.Is(err, daemonruntime.ErrTopicNotFound)) {
				t.Fatalf("topic %q: error = %v", topicID, err)
			}
		}
		if got := f.topicTexts(f.store); !reflect.DeepEqual(got, original) {
			t.Fatalf("topic = %v", got)
		}
	})
}

func errorSays(text string) func(error) bool {
	return func(err error) bool { return err != nil && strings.Contains(err.Error(), text) }
}

// The Console runtime's routes carry the edit: POST /tasks/{id}/replace reaches the runtime, and
// a message edited a second time is gone (404), a busy topic refuses (409).
func TestConsoleEditMessageRoute(t *testing.T) {
	f := newEditRuntimeFixture(t)
	mux := http.NewServeMux()
	daemonruntime.RegisterRoutes(mux, f.rt.routesOptions("tok"))
	post := func(target string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"task":"What does a fox eat?","topic_id":%q}`, f.topicID)
		req := httptest.NewRequest(http.MethodPost, "/tasks/"+target+"/replace", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	rec := post("t2")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var resp daemonruntime.ReplaceTaskResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resp.RemovedTaskIDs, []string{"t3", "t2"}) {
		t.Fatalf("response = %+v", resp)
	}
	// The replacement has not run yet: the topic is busy.
	if rec := post("t1"); rec.Code != http.StatusConflict {
		t.Fatalf("edit while the replacement runs: status = %d (%s)", rec.Code, rec.Body.String())
	}
	job, ok := f.rt.takePendingJob(resp.ID)
	if !ok {
		t.Fatal("no pending job")
	}
	job.Generation.release()
	if err := f.store.Update(resp.ID, func(info *daemonruntime.TaskInfo) { info.Status = daemonruntime.TaskDone }); err != nil {
		t.Fatal(err)
	}
	if rec := post("t2"); rec.Code != http.StatusNotFound {
		t.Fatalf("second edit of t2: status = %d (%s)", rec.Code, rec.Body.String())
	}
}
