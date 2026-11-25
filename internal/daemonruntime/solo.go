package daemonruntime

import "strings"

// Solo's records: what the Solo conversation shows of its work threads, kept as finished tasks of
// the Solo topic so they load, page and survive a restart with the rest of its history. A thread
// card ("solothread_<thread task id>") is written when Solo starts a thread and follows its task's
// state; the thread's summary ("solosummary_<thread task id>") is written once, when that task
// ends. Their IDs come from the thread task's, so writing either twice changes nothing.
const (
	SoloThreadCardPrefix    = "solothread_"
	SoloThreadSummaryPrefix = "solosummary_"

	// SoloThreadResultKey holds a record's SoloThread in its task's result.
	SoloThreadResultKey = "solo_thread"
	// SoloSourcesResultKey holds, in a Solo reply's result, what the run used: its workspace, the
	// threads it started and the sources it read ([]SoloSource).
	SoloSourcesResultKey = "solo_sources"

	// SoloThreadTriggerEvent is the trigger event of a work thread's task that Solo started.
	SoloThreadTriggerEvent = "solo_thread"
)

// A work thread's states as Solo shows them.
const (
	SoloThreadRunning  = "running"
	SoloThreadWaiting  = "waiting"
	SoloThreadDone     = "done"
	SoloThreadFailed   = "failed"
	SoloThreadCanceled = "canceled"
)

// Kinds of SoloThread record.
const (
	SoloRecordCard    = "card"
	SoloRecordSummary = "summary"
)

// SoloThread is a work thread as a Solo record shows it.
type SoloThread struct {
	Kind         string `json:"kind"`
	TopicID      string `json:"topic_id"`
	TaskID       string `json:"task_id"`
	Title        string `json:"title"`
	Workspace    string `json:"workspace,omitempty"`
	WorkspaceDir string `json:"workspace_dir,omitempty"`
	// OriginTaskID is the Solo task whose run started the thread.
	OriginTaskID string `json:"origin_task_id,omitempty"`
	State        string `json:"state"`
	// Summary is what the thread came to: the start of its reply, or why it failed.
	Summary    string `json:"summary,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	// Continued is set when the thread is an existing topic Solo gave more work.
	Continued bool `json:"continued,omitempty"`
}

// Kinds of SoloSource.
const (
	SoloSourceWorkspace = "workspace"
	SoloSourceThread    = "thread"
	SoloSourceTopic     = "topic"
	SoloSourceMemory    = "memory"
	SoloSourceJournal   = "journal"
)

// SoloSource is one thing a Solo reply used, shown as a chip under it.
type SoloSource struct {
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	Label string `json:"label,omitempty"`
}

// SoloThreadCardID is the ID of the card of the thread whose task is taskID.
func SoloThreadCardID(taskID string) string {
	return SoloThreadCardPrefix + strings.TrimSpace(taskID)
}

// SoloThreadSummaryID is the ID of the summary of the thread whose task is taskID.
func SoloThreadSummaryID(taskID string) string {
	return SoloThreadSummaryPrefix + strings.TrimSpace(taskID)
}

// SoloThreadTaskIDFromCard is the thread task ID of a card's ID, or "" when id is not a card's.
func SoloThreadTaskIDFromCard(id string) string {
	id = strings.TrimSpace(id)
	if !strings.HasPrefix(id, SoloThreadCardPrefix) {
		return ""
	}
	return strings.TrimPrefix(id, SoloThreadCardPrefix)
}

// SoloThreadStateOf is the state Solo shows for a thread whose task has status.
func SoloThreadStateOf(status TaskStatus) string {
	switch status {
	case TaskPending:
		return SoloThreadWaiting
	case TaskDone:
		return SoloThreadDone
	case TaskFailed:
		return SoloThreadFailed
	case TaskCanceled:
		return SoloThreadCanceled
	}
	return SoloThreadRunning
}

// SoloThreadStateEnded reports whether a thread in state has ended.
func SoloThreadStateEnded(state string) bool {
	switch state {
	case SoloThreadDone, SoloThreadFailed, SoloThreadCanceled:
		return true
	}
	return false
}

// soloRecordID reports whether id is a Solo record's: a work thread's card or summary.
func soloRecordID(id string) bool {
	id = strings.TrimSpace(id)
	return strings.HasPrefix(id, SoloThreadCardPrefix) || strings.HasPrefix(id, SoloThreadSummaryPrefix)
}
