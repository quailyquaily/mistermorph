package telegram

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
)

type jobTriggerRuns struct {
	mu   sync.Mutex
	runs []cronstore.RunRequest
	busy bool
}

func (r *jobTriggerRuns) run(_ context.Context, run cronstore.RunRequest) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.busy {
		return "", daemonruntime.ErrCronBusy
	}
	r.runs = append(r.runs, run)
	return "run_1", nil
}

func (r *jobTriggerRuns) snapshot() []cronstore.RunRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cronstore.RunRequest(nil), r.runs...)
}

func waitForJobTrigger(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A message in a chat a job watches starts the job, also when the agent ignores the message (a
// group message not addressed to it, another bot's message); the agent's own messages and other
// chats start nothing, and a job that is already running gets a skipped run.
func TestTelegramInboundMessageStartsWatchingJobs(t *testing.T) {
	cases := []struct {
		name    string
		message telegramMessage
		busy    bool
		want    string // the trigger that fires, or ""
	}{
		{"a group message not addressed to the agent", telegramMessage{MessageID: 1, Date: 1786071845, Chat: &telegramChat{ID: -1001, Type: "supergroup"},
			From: &telegramUser{ID: 10001, FirstName: "Ada"}, Text: "release at nine"}, false, "trg-group"},
		{"a forum topic's own trigger", telegramMessage{MessageID: 2, MessageThreadID: 8, Chat: &telegramChat{ID: -2002, Type: "supergroup"},
			From: &telegramUser{ID: 10001, FirstName: "Ada"}, Text: "in the topic"}, false, "trg-topic"},
		{"another bot's message", telegramMessage{MessageID: 3, Chat: &telegramChat{ID: -1001, Type: "supergroup"},
			From: &telegramUser{ID: 555, IsBot: true, Username: "ci_bot"}, Text: "build failed"}, false, "trg-group"},
		{"the agent's own message", telegramMessage{MessageID: 4, Chat: &telegramChat{ID: -1001, Type: "supergroup"},
			From: &telegramUser{ID: 999, IsBot: true, Username: "morphbot"}, Text: "the job's report"}, false, ""},
		{"a chat no job watches", telegramMessage{MessageID: 5, Chat: &telegramChat{ID: -3003, Type: "supergroup"},
			From: &telegramUser{ID: 10001, FirstName: "Ada"}, Text: "hello"}, false, ""},
		{"a job that is already running", telegramMessage{MessageID: 6, Chat: &telegramChat{ID: -1001, Type: "supergroup"},
			From: &telegramUser{ID: 10001, FirstName: "Ada"}, Text: "again"}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cronPath := filepath.Join(t.TempDir(), "cron.yaml")
			store := cronstore.NewStore(cronPath)
			t.Cleanup(store.Close)
			if err := store.Write(cronstore.File{Tasks: []cronstore.Task{
				{ID: "job-group", Content: "Summarize.", Triggers: []cronstore.Trigger{{ID: "trg-group", Kind: cronstore.TriggerMessage, Channel: "telegram", ChatID: "tg:-1001"}}},
				{ID: "job-topic", Content: "Summarize.", Triggers: []cronstore.Trigger{{ID: "trg-topic", Kind: cronstore.TriggerMessage, Channel: "telegram", ChatID: "tg:-2002_8"}}},
			}}); err != nil {
				t.Fatal(err)
			}
			runs := &jobTriggerRuns{busy: tc.busy}
			logs := &syncBuffer{}
			state := &telegramRuntimeState{
				logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
				allowedChatIDs:   map[int64]bool{-1001: true, -2002: true, -3003: true},
				botUser:          "morphbot",
				botID:            999,
				groupTriggerMode: "strict",
				history:          make(map[string][]chathistory.ChatHistoryItem),
				sharedRuntime:    runtimecore.ChannelRuntimeBundle{TaskRuntime: &taskruntime.Runtime{}},
				options:          RunOptions{JobTriggers: jobtriggers.New(cronPath, runs.run, slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))},
			}
			message := tc.message
			state.handleUpdate(telegramUpdate{Message: &message})
			if tc.want == "" && !tc.busy {
				time.Sleep(100 * time.Millisecond)
				if got := runs.snapshot(); len(got) != 0 {
					t.Fatalf("started %+v", got)
				}
				return
			}
			if tc.busy {
				waitForJobTrigger(t, "the skipped run", func() bool {
					history, err := store.RunHistory(context.Background(), cronstore.RunHistoryQuery{JobID: "job-group"})
					return err == nil && len(history) == 1 && history[0].Status == cronstore.RunStatusSkipped &&
						history[0].Cause.Kind == cronstore.CauseMessage && strings.Contains(history[0].Cause.Note, "already queued or running")
				})
				return
			}
			waitForJobTrigger(t, "the run", func() bool { return len(runs.snapshot()) == 1 })
			run := runs.snapshot()[0]
			if run.Cause.Kind != cronstore.CauseMessage || run.Cause.TriggerID != tc.want {
				t.Fatalf("cause = %+v", run.Cause)
			}
			if !strings.Contains(run.Input.BodyText, `"text": "`+tc.message.Text+`"`) || !strings.Contains(run.Input.BodyText, `"channel": "telegram"`) {
				t.Fatalf("input:\n%s", run.Input.BodyText)
			}
			// An edit of the same message starts nothing more.
			state.handleUpdate(telegramUpdate{EditedMessage: &message})
			waitForJobTrigger(t, "the edit to be handled", func() bool { return strings.Contains(logs.String(), "outcome=duplicate") })
			if got := runs.snapshot(); len(got) != 1 {
				t.Fatalf("an edit started the job again: %d runs", len(got))
			}
		})
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestTelegramJobTriggerMessage(t *testing.T) {
	sentAt := time.Unix(1786071845, 0).UTC()
	msg := telegramJobTriggerMessage(&telegramMessage{MessageID: 42, Chat: &telegramChat{ID: -1001}}, "tg:-1001_8", 10001, "Ada L", "ada", false, "hi", sentAt)
	if msg.Channel != "telegram" || strings.Join(msg.ChatIDs, ",") != "tg:-1001,tg:-1001_8" || msg.MessageID != "42" ||
		msg.SenderID != "tg:10001" || msg.SenderName != "Ada L" || msg.SenderIsBot || !msg.SentAt.Equal(sentAt) || msg.Text != "hi" {
		t.Fatalf("msg = %+v", msg)
	}
	// A channel post has no sender; a plain chat has one name.
	msg = telegramJobTriggerMessage(&telegramMessage{MessageID: 1, Chat: &telegramChat{ID: 77}}, "tg:77", 0, "", "", false, "", sentAt)
	if strings.Join(msg.ChatIDs, ",") != "tg:77" || msg.SenderID != "" || msg.SenderName != "" {
		t.Fatalf("msg = %+v", msg)
	}
}
