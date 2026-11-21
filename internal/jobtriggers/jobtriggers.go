// Package jobtriggers starts jobs from inbound chat messages: a job with a "message" trigger
// (a channel and a chat ID) gets one run for a message that arrives in that chat.
//
// A channel runtime calls a Dispatcher for each inbound message, before it decides whether the
// agent answers it: the conversation goes on as it would without the job, and a message the agent
// ignores (a group message not addressed to it) starts the job all the same. The run is the job's
// own, in the job's topic, and is given the message as source data, never as instructions.
package jobtriggers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	// DefaultMinInterval is the least time between two runs one message trigger starts. A message
	// that arrives sooner is dropped for that trigger: it starts nothing and leaves no history
	// row, since a busy chat would otherwise fill the job's bounded history with them.
	DefaultMinInterval = time.Minute
	// MaxTextRunes bounds the message text a run is given.
	MaxTextRunes = 4000
	// handleTimeout bounds one message's dispatch when it runs on its own (HandleAsync).
	handleTimeout = 10 * time.Second
	// seenKept is how many handled message IDs are remembered, so an edit of a message, which
	// arrives under the same ID, does not start the job again.
	seenKept = 4096
)

// Message is an inbound chat message, as a channel runtime saw it.
type Message struct {
	// Channel is the channel's name, as a trigger's channel: "telegram", "slack", "agentlink".
	Channel string
	// ChatIDs are the IDs that name the chat the message arrived in, in the form job chat IDs
	// have ("tg:-100123", "slack:T1:C1", "mm:inst_ab12"). A trigger matches when its chat_id is
	// one of them; a chat with several names (a Telegram forum topic is also its group) lists all.
	ChatIDs []string
	// MessageID names the message on its platform; an edit carries the same one.
	MessageID  string
	SenderID   string
	SenderName string
	// SenderIsBot marks a message another bot or agent sent. It still starts a job.
	SenderIsBot bool
	// FromSelf marks a message this agent sent itself, a job's notification to the chat among
	// them. It never starts a job. Runtimes drop such messages before they get here where the
	// platform delivers them at all; the flag is the second guard.
	FromSelf bool
	SentAt   time.Time
	Text     string
}

// Outcome is what a message came to for one job.
type Outcome string

const (
	// Started: a run was queued.
	Started Outcome = "started"
	// Busy: the job was already queued or running; a skipped run was recorded.
	Busy Outcome = "busy"
	// RateLimited: the trigger started (or tried to start) a run less than the interval ago; the
	// message was dropped for it.
	RateLimited Outcome = "rate_limited"
	// Duplicate: the message was handled before (an edit); dropped.
	Duplicate Outcome = "duplicate"
	// Failed: the run could not be queued.
	Failed Outcome = "failed"
)

// Result is one job a message matched, and what came of it.
type Result struct {
	JobID     string
	TriggerID string
	Outcome   Outcome
	RunID     string
	Err       error
}

// Dispatcher starts the jobs of one job list from inbound messages.
type Dispatcher struct {
	cronPath string
	run      daemonruntime.CronRunFunc
	logger   *slog.Logger
	// MinInterval replaces DefaultMinInterval when set.
	MinInterval time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// New returns a dispatcher for the job list at cronPath whose runs run asks for, or nil when
// either is missing: a runtime without a cron loop starts no jobs. A nil dispatcher does nothing.
func New(cronPath string, run daemonruntime.CronRunFunc, logger *slog.Logger) *Dispatcher {
	cronPath = strings.TrimSpace(cronPath)
	if cronPath == "" || run == nil {
		return nil
	}
	return &Dispatcher{cronPath: cronPath, run: run, logger: logger}
}

// state is what the dispatchers of one process remember, by job list: when each trigger last
// fired and which messages were handled. Several runtimes in one process share a job list.
var state = struct {
	sync.Mutex
	lastFired map[string]time.Time
	seen      map[string]uint64
	seenSeq   uint64
}{lastFired: map[string]time.Time{}, seen: map[string]uint64{}}

func (d *Dispatcher) key(parts ...string) string {
	path := pathutil.ExpandHomePath(d.cronPath)
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return filepath.Clean(path) + "\x00" + strings.Join(parts, "\x00")
}

func (d *Dispatcher) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// HandleAsync handles msg in the background, so the runtime's own handling of the message does
// not wait for the job list or the cron loop.
func (d *Dispatcher) HandleAsync(msg Message) {
	if d == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), handleTimeout)
		defer cancel()
		d.Handle(ctx, msg)
	}()
}

// Handle queues one run of each enabled job that has a message trigger for the message's channel
// and chat, and returns what came of it for each job the message matched. A job is started at
// most once per message, by the first of its triggers that matches.
func (d *Dispatcher) Handle(ctx context.Context, msg Message) []Result {
	if d == nil || msg.FromSelf {
		return nil
	}
	channel := strings.ToLower(strings.TrimSpace(msg.Channel))
	chatIDs := make([]string, 0, len(msg.ChatIDs))
	for _, id := range msg.ChatIDs {
		if id = strings.TrimSpace(id); id != "" {
			chatIDs = append(chatIDs, id)
		}
	}
	if channel == "" || len(chatIDs) == 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store := cronstore.NewStore(d.cronPath)
	tasks, err := store.Tasks(ctx)
	if err != nil {
		d.log(slog.LevelWarn, "job_message_trigger_error", "channel", channel, "error", err.Error())
		return nil
	}
	var results []Result
	for _, task := range tasks {
		trigger, chatID, ok := matchingTrigger(task, channel, chatIDs)
		if !ok || !cronstore.TaskEnabled(task) {
			continue
		}
		result := d.start(ctx, store, task, trigger, chatID, msg)
		level := slog.LevelInfo
		if result.Outcome == RateLimited || result.Outcome == Duplicate {
			level = slog.LevelDebug
		}
		d.log(level, "job_message_trigger", "job_id", result.JobID, "trigger_id", result.TriggerID, "channel", channel,
			"chat_id", chatID, "outcome", string(result.Outcome), "run_id", result.RunID)
		results = append(results, result)
	}
	return results
}

func matchingTrigger(task cronstore.Task, channel string, chatIDs []string) (cronstore.Trigger, string, bool) {
	for _, trigger := range cronstore.TriggersForTask(task) {
		if trigger.Kind != cronstore.TriggerMessage || !strings.EqualFold(strings.TrimSpace(trigger.Channel), channel) {
			continue
		}
		for _, chatID := range chatIDs {
			if strings.EqualFold(strings.TrimSpace(trigger.ChatID), chatID) {
				return trigger, chatID, true
			}
		}
	}
	return cronstore.Trigger{}, "", false
}

func (d *Dispatcher) start(ctx context.Context, store *cronstore.Store, task cronstore.Task, trigger cronstore.Trigger, chatID string, msg Message) Result {
	jobID := strings.TrimSpace(task.ID)
	result := Result{JobID: jobID, TriggerID: trigger.ID}
	now := d.now()
	interval := d.MinInterval
	if interval <= 0 {
		interval = DefaultMinInterval
	}
	limitKey := d.key("trigger", jobID, trigger.ID)
	seenKey := ""
	if messageID := strings.TrimSpace(msg.MessageID); messageID != "" {
		seenKey = d.key("message", jobID, strings.ToLower(strings.TrimSpace(msg.Channel)), chatID, messageID)
	}
	state.Lock()
	if _, dup := state.seen[seenKey]; dup && seenKey != "" {
		state.Unlock()
		result.Outcome = Duplicate
		return result
	}
	if last, fired := state.lastFired[limitKey]; fired && now.Sub(last) < interval && !now.Before(last) {
		state.Unlock()
		result.Outcome = RateLimited
		return result
	}
	// Taken before the run is asked for, so two messages that arrive together start one run.
	state.lastFired[limitKey] = now
	if seenKey != "" {
		state.seenSeq++
		state.seen[seenKey] = state.seenSeq
		if len(state.seen) > seenKept {
			cut := state.seenSeq - seenKept/2
			for key, seq := range state.seen {
				if seq <= cut {
					delete(state.seen, key)
				}
			}
		}
	}
	state.Unlock()

	cause := cronstore.RunCause{Kind: cronstore.CauseMessage, TriggerID: trigger.ID}
	runID, err := d.run(ctx, cronstore.RunRequest{Task: task, Cause: cause, Input: Input(msg, chatID)})
	switch {
	case err == nil:
		result.Outcome, result.RunID = Started, runID
	case errors.Is(err, daemonruntime.ErrCronBusy):
		result.Outcome = Busy
		at := cronstore.RunTime(now)
		cause.Note = "not started: the job was already queued or running"
		if run, recordErr := store.RecordRun(context.Background(), cronstore.RunRecord{JobID: jobID, Status: cronstore.RunStatusSkipped,
			QueuedAt: at, FinishedAt: at, Cause: cause}); recordErr != nil {
			d.log(slog.LevelWarn, "job_message_trigger_error", "job_id", jobID, "error", recordErr.Error())
		} else {
			result.RunID = run.RunID
		}
	default:
		result.Outcome, result.Err = Failed, err
		d.log(slog.LevelWarn, "job_message_trigger_error", "job_id", jobID, "trigger_id", trigger.ID, "error", err.Error())
	}
	return result
}

func (d *Dispatcher) log(level slog.Level, msg string, args ...any) {
	if d.logger != nil {
		d.logger.Log(context.Background(), level, msg, args...)
	}
}

// messageData is the message as a run reads it. It is JSON, so no text in the message can end
// the block it is quoted in or pass for anything but a field's value.
type messageData struct {
	Channel   string        `json:"channel"`
	ChatID    string        `json:"chat_id"`
	MessageID string        `json:"message_id,omitempty"`
	Sender    messageSender `json:"sender"`
	SentAt    string        `json:"sent_at,omitempty"`
	Text      string        `json:"text"`
	Truncated bool          `json:"text_truncated,omitempty"`
}

type messageSender struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name,omitempty"`
	IsBot bool   `json:"is_bot,omitempty"`
}

// Input is the source data of a run a message started: the message's sender, time and text, as
// JSON. chatID is the chat ID the trigger matched.
func Input(msg Message, chatID string) awarenessdomain.PokeInput {
	data := messageData{
		Channel:   strings.ToLower(strings.TrimSpace(msg.Channel)),
		ChatID:    strings.TrimSpace(chatID),
		MessageID: strings.TrimSpace(msg.MessageID),
		Sender:    messageSender{ID: strings.TrimSpace(msg.SenderID), Name: strings.TrimSpace(msg.SenderName), IsBot: msg.SenderIsBot},
		Text:      strings.TrimSpace(msg.Text),
	}
	if !msg.SentAt.IsZero() {
		data.SentAt = msg.SentAt.UTC().Format(time.RFC3339)
	}
	if runes := []rune(data.Text); len(runes) > MaxTextRunes {
		data.Text = strings.TrimSpace(string(runes[:MaxTextRunes]))
		data.Truncated = true
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return awarenessdomain.PokeInput{}
	}
	return awarenessdomain.PokeInput{ContentType: "application/json", BodyText: strings.TrimSpace(b.String()), HasBody: true, Truncated: data.Truncated}
}
