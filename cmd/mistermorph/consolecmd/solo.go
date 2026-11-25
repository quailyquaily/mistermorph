package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/memorytools"
	"github.com/quailyquaily/mistermorph/internal/ownertools"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
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
	// soloPromptThreads is how many recent work threads a Solo run is told about.
	soloPromptThreads = 10
	// soloRecordScan is how many of Solo's newest tasks are read for its thread records.
	soloRecordScan = 200
	// soloSummaryRunes and soloPromptSummaryRunes cut a thread's reply for Solo and its prompt.
	soloSummaryRunes       = 1500
	soloPromptSummaryRunes = 300
	soloCardSummaryRunes   = 600
)

// consoleSoloTopics is the topic reader of the Console's routes: the store, with Solo made on the
// first listing (or the first look at it), so every agent's Console shows it from the start.
type consoleSoloTopics struct {
	r *consoleLocalRuntime
}

func (t consoleSoloTopics) ListTopicsPage(opts daemonruntime.TopicListOptions) []daemonruntime.TopicInfo {
	if strings.TrimSpace(opts.Cursor) == "" {
		t.r.ensureSoloTopic()
	}
	return t.r.store.ListTopicsPage(opts)
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

// soloThreadOf reads a Solo record's thread from its task's result.
func soloThreadOf(info daemonruntime.TaskInfo) (daemonruntime.SoloThread, bool) {
	result, ok := info.Result.(map[string]any)
	if !ok {
		return daemonruntime.SoloThread{}, false
	}
	value, ok := result[daemonruntime.SoloThreadResultKey]
	if !ok || value == nil {
		return daemonruntime.SoloThread{}, false
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return daemonruntime.SoloThread{}, false
	}
	var rec daemonruntime.SoloThread
	if json.Unmarshal(raw, &rec) != nil || strings.TrimSpace(rec.TaskID) == "" {
		return daemonruntime.SoloThread{}, false
	}
	return rec, true
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
	rec, ok := soloThreadOf(*card)
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
			rec.Summary = cutRunes(soloThreadOutcome(task, found), soloCardSummaryRunes)
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
	rec.Summary = cutRunes(outcome, soloSummaryRunes)
	var head string
	switch rec.State {
	case daemonruntime.SoloThreadDone:
		head = fmt.Sprintf("Work thread %q is done", rec.Title)
	case daemonruntime.SoloThreadCanceled:
		head = fmt.Sprintf("Work thread %q was stopped", rec.Title)
	default:
		head = fmt.Sprintf("Work thread %q failed", rec.Title)
	}
	text := fmt.Sprintf("%s (topic %s, workspace %s).\n\n%s", head, rec.TopicID, rec.Workspace, rec.Summary)
	info := soloRecordInfo(summaryID, rec, text, time.Now())
	if err := r.store.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "ui", Event: "solo_thread_summary", Ref: rec.TopicID}, ""); err != nil {
		r.currentLogger().Warn("console_solo_summary_write_failed", "task_id", rec.TaskID, "error", err.Error())
	}
}

// soloThreadRecords are Solo's thread cards, newest first.
func (r *consoleLocalRuntime) soloThreadRecords(limit int) []daemonruntime.SoloThread {
	if r == nil || r.store == nil {
		return nil
	}
	tasks := r.store.List(daemonruntime.TaskListOptions{TopicID: daemonruntime.ConsoleSoloTopicID, Limit: soloRecordScan})
	var out []daemonruntime.SoloThread
	for _, task := range tasks {
		if daemonruntime.SoloThreadTaskIDFromCard(task.ID) == "" {
			continue
		}
		if rec, ok := soloThreadOf(task); ok {
			out = append(out, rec)
			if limit > 0 && len(out) == limit {
				break
			}
		}
	}
	return out
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

// soloPromptBlock tells a Solo run what Solo is and what its recent work threads came to, so the
// threads stay known however far back they were started and whatever compaction kept.
func (r *consoleLocalRuntime) soloPromptBlock() agent.PromptBlock {
	var b strings.Builder
	b.WriteString("## Solo\n\n")
	b.WriteString("This is Solo, the owner's one conversation with you. For each message decide: answer here; recall what you need (memory_search, journal_search and journal_read, topic_search and topic_read for earlier work in other topics); or work. ")
	b.WriteString("Work that needs a project folder or will take more than a short while goes into a work thread with work_thread: a topic of its own, with its workspace, running in the background while Solo stays free. Give it a short title and a complete task (the thread does not see this conversation), then answer briefly; do not wait for it. ")
	b.WriteString("Give an earlier thread more work by passing its topic_id. Short work in a known workspace may run here with workspace_use. ")
	b.WriteString("When it is not clear which workspace a piece of work belongs to, ask the user (ask_user, or in your reply) instead of guessing; never invent a path. ")
	b.WriteString("A thread's card shows its state here and its summary comes here when it ends; the user can open a thread and go on there.\n")
	records := r.soloThreadRecords(soloPromptThreads)
	if len(records) > 0 {
		b.WriteString("\nRecent work threads, newest first:\n")
		for _, rec := range records {
			fmt.Fprintf(&b, "- %q, topic %s, workspace %s: %s", rec.Title, rec.TopicID, rec.Workspace, rec.State)
			if summary := strings.Join(strings.Fields(rec.Summary), " "); summary != "" {
				fmt.Fprintf(&b, " — %s", cutRunes(summary, soloPromptSummaryRunes))
			}
			b.WriteString("\n")
		}
	}
	return agent.PromptBlock{Content: b.String()}
}

func cutRunes(text string, max int) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

// soloSourceCollector gathers, from a Solo run's finished tool calls, the workspace it used and
// the threads and sources it touched: only what its calls actually did, never a guess.
type soloSourceCollector struct {
	mu      sync.Mutex
	runID   string
	home    string
	items   []daemonruntime.SoloSource
	seen    map[string]bool
	threads map[string]bool
}

func newSoloSourceCollector(runID string) *soloSourceCollector {
	return &soloSourceCollector{runID: strings.TrimSpace(runID), home: workspace.HostHomeDir(), seen: map[string]bool{}, threads: map[string]bool{}}
}

// soloWorkspaceTools are the calls that work in the run's workspace.
var soloWorkspaceTools = map[string]bool{
	"read_file": true, "write_file": true, "bash": true, "powershell": true, "coder": true,
}

func (c *soloSourceCollector) HandleEvent(ctx context.Context, event agent.Event) {
	if c == nil || event.Kind != agent.EventKindToolDone || strings.TrimSpace(event.Error) != "" || event.Worker != nil {
		return
	}
	if runID := strings.TrimSpace(event.RunID); runID != "" && runID != c.runID {
		return
	}
	name := strings.TrimSpace(event.ToolName)
	switch {
	case name == ownertools.WorkspaceUseName:
		var out struct {
			Dir     string `json:"workspace_dir"`
			Display string `json:"display"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.Dir) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceWorkspace, ID: out.Dir, Label: out.Display})
		}
	case soloWorkspaceTools[name]:
		if path, _ := event.Args["path"].(string); strings.HasPrefix(strings.TrimSpace(path), "file_cache_dir") {
			return
		}
		if dir, ok := pathroots.WorkspaceDirFromContext(ctx); ok && strings.TrimSpace(dir) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceWorkspace, ID: dir, Label: ownertools.DisplayPath(dir, c.home)})
		}
	case name == ownertools.TopicReadName:
		var out struct {
			Topic struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"topic"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.Topic.ID) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceTopic, ID: out.Topic.ID, Label: out.Topic.Title})
		}
	case name == ownertools.WorkThreadName:
		var out struct {
			TopicID   string `json:"topic_id"`
			Title     string `json:"title"`
			Workspace string `json:"workspace"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(event.Text)), &out) == nil && strings.TrimSpace(out.TopicID) != "" {
			c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceThread, ID: out.TopicID, Label: out.Title})
		}
	case name == memorytools.SearchName || name == memorytools.SaveName || name == memorytools.ForgetName:
		c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceMemory})
	case name == memorytools.JournalSearchName || name == memorytools.JournalReadName:
		c.add(daemonruntime.SoloSource{Kind: daemonruntime.SoloSourceJournal})
	}
}

func (c *soloSourceCollector) add(source daemonruntime.SoloSource) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := source.Kind + "\x00" + source.ID
	if c.seen[key] {
		return
	}
	c.seen[key] = true
	if source.Kind == daemonruntime.SoloSourceThread {
		c.threads[source.ID] = true
	}
	c.items = append(c.items, source)
}

// Sources is what the run used, in the order it first used each; a topic the run started a thread
// in shows once, as the thread.
func (c *soloSourceCollector) Sources() []daemonruntime.SoloSource {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]daemonruntime.SoloSource, 0, len(c.items))
	for _, item := range c.items {
		if item.Kind == daemonruntime.SoloSourceTopic && c.threads[item.ID] {
			continue
		}
		out = append(out, item)
	}
	return out
}
