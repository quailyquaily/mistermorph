package consolecmd

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/ownertools"
	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/solo"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

// Solo is the owner's one pinned conversation with the agent (daemonruntime.ConsoleSoloTopicID).
// Its runs are owner chat runs with one tool more, work_thread, which starts work in an ordinary
// topic of its own (a work thread) with the workspace it needs, and returns at once. Solo keeps a
// card for each thread it started, following the thread's task, and gets the thread's summary
// when that task ends (daemonruntime.SoloThread records). Its replies carry the workspace they
// used and the threads and sources they touched (daemonruntime.SoloSource), from the run's own
// tool calls.

const (
	// soloSummaryRunes and soloCardSummaryRunes cut a thread's reply for its summary and its card.
	soloSummaryRunes     = 1500
	soloCardSummaryRunes = 600
)

// consoleSoloTopics is the topic reader of the Console's routes: the store, with Solo made on the
// first listing (or the first look at it), so every agent's Console shows it from the start.
// Solo is always first on the first page, however many topics were used since, and the pages
// after it leave it out.
type consoleSoloTopics struct {
	r *consoleLocalRuntime
}

func (t consoleSoloTopics) ListTopicsPage(opts daemonruntime.TopicListOptions) []daemonruntime.TopicInfo {
	first := strings.TrimSpace(opts.Cursor) == ""
	if first {
		t.r.ensureSoloTopic()
	}
	// The route asks for one more than it shows and takes its next cursor from the last one shown,
	// so a pinned Solo needs at least one store topic after it on the page (Limit > 2).
	if opts.Limit <= 2 {
		return t.r.store.ListTopicsPage(opts)
	}
	items := t.r.store.ListTopicsPage(opts)
	out := make([]daemonruntime.TopicInfo, 0, len(items)+1)
	if first {
		solo, ok := t.r.store.GetTopic(daemonruntime.ConsoleSoloTopicID)
		if !ok || solo == nil {
			return items
		}
		out = append(out, *solo)
	}
	// Solo, wherever the store has it (even as the route's look-ahead), is only in front of the
	// first page; a page that loses it takes the store's next topic in its place.
	for _, item := range items {
		if !daemonruntime.IsSoloTopicID(item.ID) {
			out = append(out, item)
		}
	}
	if len(out) > opts.Limit {
		return out[:opts.Limit]
	}
	if len(out) < opts.Limit && len(items) == opts.Limit {
		last := items[len(items)-1]
		next := t.r.store.ListTopicsPage(daemonruntime.TopicListOptions{Limit: 1, Cursor: pagination.EncodeKeysetCursor(last.UpdatedAt, last.ID)})
		out = append(out, next...)
	}
	return out
}

func (t consoleSoloTopics) GetTopic(id string) (*daemonruntime.TopicInfo, bool) {
	if daemonruntime.IsSoloTopicID(id) {
		t.r.ensureSoloTopic()
	}
	return t.r.store.GetTopic(id)
}

// ensureSoloTopic makes Solo once per runtime: Solo cannot be deleted, so once made it stays.
func (r *consoleLocalRuntime) ensureSoloTopic() {
	if r == nil || r.store == nil || r.soloReady.Load() {
		return
	}
	if _, err := r.store.EnsureSoloTopic(); err != nil {
		r.currentLogger().Warn("console_solo_topic_create_failed", "error", err.Error())
		return
	}
	r.soloReady.Store(true)
}

// consoleSoloRun reports whether a Console task is a Solo run: the owner's chat run in Solo.
func consoleSoloRun(job consoleLocalTaskJob) bool {
	return daemonruntime.IsSoloTopicID(job.TopicID) && consoleOwnerChatRun(job)
}

// consoleSoloThreadTask reports whether a task is a work thread's task that Solo started.
func consoleSoloThreadTask(trigger daemonruntime.TaskTrigger) bool {
	return strings.TrimSpace(trigger.Event) == daemonruntime.SoloThreadTriggerEvent
}

// soloThreadWorkspaceSwitch is the workspace of a work thread's task that Solo started: its
// topic's, where the first write or command asks the user first unless it is Solo's own workspace
// (the one Solo works in without asking).
func (r *consoleLocalRuntime) soloThreadWorkspaceSwitch(ctx context.Context, job consoleLocalTaskJob, defaultWorkspaceDir string) *pathroots.WorkspaceSwitch {
	solo, err := r.workspaceForTopic(ctx, daemonruntime.ConsoleSoloTopicID, defaultWorkspaceDir)
	if err == nil && strings.TrimSpace(solo.WorkspaceDir) != "" && pathroots.SameDir(solo.WorkspaceDir, job.WorkspaceDir) {
		return pathroots.NewWorkspaceSwitch(job.WorkspaceDir)
	}
	return pathroots.NewWorkspaceSwitchAwaitingApproval(job.WorkspaceDir)
}

// startSoloThread is work_thread's starter: it records the thread's task in its topic (a new one
// named for the work, or the existing one), records the thread's card in Solo, then hands the task
// to the queue like any Console task. It does not wait for the task.
func (r *consoleLocalRuntime) startSoloThread(_ context.Context, req ownertools.ThreadRequest) (ownertools.ThreadStarted, error) {
	if r == nil || r.store == nil {
		return ownertools.ThreadStarted{}, fmt.Errorf("console runtime is not initialized")
	}
	generation, err := r.captureGeneration()
	if err != nil {
		return ownertools.ThreadStarted{}, err
	}
	releaseGeneration := true
	defer func() {
		if releaseGeneration {
			generation.release()
		}
	}()
	if !canSubmitGeneration(generation) {
		return ownertools.ThreadStarted{}, fmt.Errorf("the runtime cannot run tasks now")
	}
	topicID := strings.TrimSpace(req.TopicID)
	title := strings.TrimSpace(req.Title)
	continued := topicID != ""
	createdTopic := false
	if continued {
		topic, ok := r.store.GetTopic(topicID)
		if !ok || topic == nil || topic.DeletedAt != nil {
			return ownertools.ThreadStarted{}, fmt.Errorf("no topic %s", topicID)
		}
		if strings.TrimSpace(topic.Title) != "" {
			title = strings.TrimSpace(topic.Title)
		}
	} else {
		topic, err := r.store.CreateThreadTopic(title, daemonruntime.ConsoleSoloTopicID)
		if err != nil {
			return ownertools.ThreadStarted{}, err
		}
		topicID = topic.ID
		createdTopic = true
	}
	trigger := daemonruntime.TaskTrigger{Source: "ui", Event: daemonruntime.SoloThreadTriggerEvent, Ref: consoleChatTriggerRef}
	job, resp, err := r.acceptTask(generation, req.Task, "", "", consoleDefaultTimeoutFromReader(generation.reader), topicID, "", req.WorkspaceDir, nil, trigger)
	if err != nil {
		if createdTopic {
			if _, delErr := r.deleteTopic(topicID); delErr != nil {
				r.currentLogger().Warn("console_solo_thread_topic_cleanup_failed", "topic_id", topicID, "error", delErr.Error())
			}
		}
		if errors.Is(err, daemonruntime.ErrTopicBusy) {
			return ownertools.ThreadStarted{}, fmt.Errorf("topic %s is still working on something; wait for it, or start a new thread", topicID)
		}
		return ownertools.ThreadStarted{}, err
	}
	display := ownertools.DisplayPath(job.WorkspaceDir, workspace.HostHomeDir())
	started := ownertools.ThreadStarted{TopicID: topicID, TaskID: job.TaskID, Title: title, Workspace: display, Continued: continued}
	if err := r.writeSoloThreadCard(daemonruntime.SoloThread{
		Kind:         daemonruntime.SoloRecordCard,
		TopicID:      topicID,
		TaskID:       job.TaskID,
		Title:        title,
		Workspace:    display,
		WorkspaceDir: job.WorkspaceDir,
		OriginTaskID: strings.TrimSpace(req.OriginTaskID),
		State:        daemonruntime.SoloThreadRunning,
		StartedAt:    job.CreatedAt.UTC().Format(time.RFC3339),
		Continued:    continued,
	}); err != nil {
		// Without its card the thread would run unseen from Solo: it does not start.
		_ = runtimecore.MarkTaskFailed(r.store, job.TaskID, "Solo could not record the thread: "+err.Error(), false)
		return ownertools.ThreadStarted{}, err
	}
	// The thread's task outlives the Solo run that started it.
	_, transferred, err := r.publishAcceptedTask(context.Background(), job, resp)
	if transferred {
		releaseGeneration = false
	}
	if err != nil {
		r.syncSoloThread(job.TaskID)
		return ownertools.ThreadStarted{}, err
	}
	return started, nil
}

// soloRecordInfo is a Solo record as a finished task of the Solo topic, its text what the agent
// reads of it in Solo's history.
func soloRecordInfo(id string, rec daemonruntime.SoloThread, text string, at time.Time) daemonruntime.TaskInfo {
	at = at.UTC()
	finished := at
	return daemonruntime.TaskInfo{
		ID:         id,
		Status:     daemonruntime.TaskDone,
		TopicID:    daemonruntime.ConsoleSoloTopicID,
		CreatedAt:  at,
		StartedAt:  &finished,
		FinishedAt: &finished,
		Result:     soloRecordResult(rec, text),
		Conversation: runtimecore.ConversationWithAudience(runtimecore.BuildTaskConversation(
			buildConsoleConversationKey(daemonruntime.ConsoleSoloTopicID),
			"private",
			consoleParticipantKey,
			consoleDisplayName,
			"",
			nil,
		), audience.Owner()),
	}
}

func soloRecordResult(rec daemonruntime.SoloThread, text string) map[string]any {
	return map[string]any{
		"final":                           map[string]any{"output": strings.TrimSpace(text)},
		daemonruntime.SoloThreadResultKey: rec,
	}
}

func soloCardText(rec daemonruntime.SoloThread) string {
	verb := "Started work thread"
	if rec.Continued {
		verb = "Gave more work to thread"
	}
	text := fmt.Sprintf("%s %q (topic %s, workspace %s).", verb, rec.Title, rec.TopicID, rec.Workspace)
	switch rec.State {
	case daemonruntime.SoloThreadWaiting:
		text += " It waits for the user's approval in the thread."
	case daemonruntime.SoloThreadDone, daemonruntime.SoloThreadFailed, daemonruntime.SoloThreadCanceled:
		text += " It ended: " + rec.State + "."
	}
	return text
}

func (r *consoleLocalRuntime) writeSoloThreadCard(rec daemonruntime.SoloThread) error {
	r.soloMu.Lock()
	defer r.soloMu.Unlock()
	info := soloRecordInfo(daemonruntime.SoloThreadCardID(rec.TaskID), rec, soloCardText(rec), time.Now())
	return r.store.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "ui", Event: "solo_thread_card", Ref: rec.TopicID}, "")
}

// observeSoloThreadTask follows the tasks of work threads Solo started: each change of status
// updates the thread's card, and the end brings its summary. It runs under the store's lock, so
// the update runs on its own.
func (r *consoleLocalRuntime) observeSoloThreadTask(previous, next daemonruntime.TaskInfo, trigger daemonruntime.TaskTrigger) {
	if r == nil || !consoleSoloThreadTask(trigger) || previous.Status == next.Status || strings.TrimSpace(next.ID) == "" {
		return
	}
	r.soloSyncs.Add(1)
	go func() {
		defer r.soloSyncs.Done()
		r.syncSoloThread(next.ID)
	}()
}

// syncSoloThread brings a thread's card up to its task's state and, once the task has ended,
// posts the thread's summary to Solo: once, whatever calls it again (a later update, the check
// after a restart).
func (r *consoleLocalRuntime) syncSoloThread(taskID string) {
	if r == nil || r.store == nil {
		return
	}
	taskID = strings.TrimSpace(taskID)
	r.soloMu.Lock()
	defer r.soloMu.Unlock()
	cardID := daemonruntime.SoloThreadCardID(taskID)
	card, ok := r.store.Get(cardID)
	if !ok || card == nil || card.TopicID != daemonruntime.ConsoleSoloTopicID {
		return
	}
	rec, ok := solo.ThreadOf(*card)
	if !ok {
		return
	}
	task, found := r.store.Get(taskID)
	state := daemonruntime.SoloThreadFailed
	if found && task != nil {
		state = daemonruntime.SoloThreadStateOf(task.Status)
	}
	ended := daemonruntime.SoloThreadStateEnded(state)
	if rec.State != state {
		rec.State = state
		if ended {
			finished := time.Now().UTC()
			if found && task != nil && task.FinishedAt != nil {
				finished = task.FinishedAt.UTC()
			}
			rec.FinishedAt = finished.Format(time.RFC3339)
			rec.Summary = solo.CutRunes(soloThreadOutcome(task, found), soloCardSummaryRunes)
		}
		if err := r.store.Update(cardID, func(info *daemonruntime.TaskInfo) {
			info.Result = soloRecordResult(rec, soloCardText(rec))
		}); err != nil {
			r.currentLogger().Warn("console_solo_card_update_failed", "task_id", taskID, "error", err.Error())
			return
		}
	}
	if ended {
		r.postSoloSummaryLocked(rec, task, found)
	}
}

// soloThreadOutcome is what a finished thread came to, in its own words: its reply, or why it
// failed or stopped.
func soloThreadOutcome(task *daemonruntime.TaskInfo, found bool) string {
	if !found || task == nil {
		return "The thread's task is gone."
	}
	reply := chathistory.TaskResultOutput(task.Result)
	errText := strings.TrimSpace(task.Error)
	switch task.Status {
	case daemonruntime.TaskDone:
		if reply == "" {
			return "It finished without a reply."
		}
		return reply
	case daemonruntime.TaskCanceled:
		if errText != "" {
			return errText
		}
		return "It was stopped."
	default:
		if errText != "" {
			return errText
		}
		if reply != "" {
			return reply
		}
		return "It stopped without saying why."
	}
}

func (r *consoleLocalRuntime) postSoloSummaryLocked(rec daemonruntime.SoloThread, task *daemonruntime.TaskInfo, found bool) {
	summaryID := daemonruntime.SoloThreadSummaryID(rec.TaskID)
	if _, exists := r.store.Get(summaryID); exists {
		return
	}
	outcome := soloThreadOutcome(task, found)
	rec.Kind = daemonruntime.SoloRecordSummary
	rec.Summary = solo.CutRunes(outcome, soloSummaryRunes)
	var head string
	switch rec.State {
	case daemonruntime.SoloThreadDone:
		head = fmt.Sprintf("Work thread %q is done", rec.Title)
	case daemonruntime.SoloThreadCanceled:
		head = fmt.Sprintf("Work thread %q was stopped", rec.Title)
	default:
		head = fmt.Sprintf("Work thread %q failed", rec.Title)
	}
	// The reply goes into Solo's history, which a later Solo run reads as its own: quoted as data.
	text := fmt.Sprintf("%s (topic %s, workspace %s).", head, rec.TopicID, rec.Workspace)
	if quoted := solo.QuoteReply(rec.Summary); quoted != "" {
		text += "\n\n" + quoted
	}
	info := soloRecordInfo(summaryID, rec, text, time.Now())
	if err := r.store.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "ui", Event: "solo_thread_summary", Ref: rec.TopicID}, ""); err != nil {
		r.currentLogger().Warn("console_solo_summary_write_failed", "task_id", rec.TaskID, "error", err.Error())
	}
}

// soloThreadRecords are Solo's thread cards, newest first (all of them when limit is 0).
func (r *consoleLocalRuntime) soloThreadRecords(limit int) []daemonruntime.SoloThread {
	if r == nil || r.store == nil {
		return nil
	}
	return solo.ThreadRecords(r.store, limit)
}

// reconcileSoloThreads catches up on the threads whose end Solo missed: their task ended (or was
// failed by the recovery after a restart) while nothing was watching.
func (r *consoleLocalRuntime) reconcileSoloThreads() {
	for _, rec := range r.soloThreadRecords(0) {
		if _, ok := r.store.Get(daemonruntime.SoloThreadSummaryID(rec.TaskID)); ok {
			continue
		}
		r.syncSoloThread(rec.TaskID)
	}
}

// soloPromptBlock is a Console Solo run's Solo block (solo.PromptBlock).
func (r *consoleLocalRuntime) soloPromptBlock() agent.PromptBlock {
	return solo.PromptBlock(solo.PromptConsole, r.soloThreadRecords(solo.PromptThreads))
}
