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
	// Participants are the subagents and coders the thread's task started, in start order: the
	// newest SoloParticipantLimit of them, with ParticipantsOmitted counting the older ones that
	// are no longer listed. A task that started none, and a record from before they were kept,
	// has neither.
	Participants        []SoloParticipant `json:"participants,omitempty"`
	ParticipantsOmitted int               `json:"participants_omitted,omitempty"`
}

// SoloParticipantLimit is the most participants a SoloThread lists; the oldest go first.
const SoloParticipantLimit = 32

// Kinds of SoloParticipant.
const (
	SoloParticipantSubagent = "subagent"
	SoloParticipantCoder    = "coder"
)

// SoloParticipant is who one worker of a thread's task is, and how it is doing: the worker's
// identity as its task allocated it (agent.WorkerMetadata), its kind and its status. It names the
// worker only: never what it was asked, what it printed or answered, or its processes.
type SoloParticipant struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	// NameSet, NameIndex and AvatarIndex are the picks a client turns into a name in its own
	// language and a logo style; older workers lack them.
	NameSet     string `json:"name_set,omitempty"`
	NameIndex   *int   `json:"name_index,omitempty"`
	AvatarIndex *int   `json:"avatar_index,omitempty"`
	// Kind is SoloParticipantCoder for a coder call, else SoloParticipantSubagent.
	Kind string `json:"kind"`
	// Status is the worker's own last status ("running", "done", "failed", "canceled", ...).
	Status string `json:"status,omitempty"`
}

// NormalizeSoloParticipants is raw as a record keeps it: trimmed, without workers that have no
// ID, each ID once (a repeat updates the first), kinds and statuses in their known words, and at
// most SoloParticipantLimit of them. The second result counts the ones cut off the front.
func NormalizeSoloParticipants(raw []SoloParticipant) ([]SoloParticipant, int) {
	out := make([]SoloParticipant, 0, len(raw))
	seen := make(map[string]int, len(raw))
	for _, item := range raw {
		item = cleanSoloParticipant(item)
		if item.ID == "" {
			continue
		}
		if i, ok := seen[item.ID]; ok {
			out[i] = updateSoloParticipant(out[i], item)
			continue
		}
		seen[item.ID] = len(out)
		out = append(out, item)
	}
	cut := 0
	if extra := len(out) - SoloParticipantLimit; extra > 0 {
		cut = extra
		out = append([]SoloParticipant(nil), out[extra:]...)
	}
	if len(out) == 0 {
		return nil, cut
	}
	return out, cut
}

// MergeSoloParticipants brings a record's participants up to a later reading of its task's
// workers (more, with moreOmitted workers the reading itself no longer lists). A worker the
// record has is updated, a new one follows the others, and no worker is lost because the reading
// lacks it: a task resumed after a pause reports only the workers of its latest run. The count of
// omitted workers never counts one twice: what the record dropped, or what the reading dropped,
// whichever is more.
func MergeSoloParticipants(have []SoloParticipant, haveOmitted int, more []SoloParticipant, moreOmitted int) ([]SoloParticipant, int) {
	joined := make([]SoloParticipant, 0, len(have)+len(more))
	joined = append(joined, have...)
	joined = append(joined, more...)
	out, cut := NormalizeSoloParticipants(joined)
	return out, max(0, max(haveOmitted, 0)+cut, moreOmitted)
}

// EndSoloParticipants is participants once their task ended in state: a worker still marked live
// took the task's ending with it, and one that ended on its own keeps how it ended.
func EndSoloParticipants(participants []SoloParticipant, state string) []SoloParticipant {
	if !SoloThreadStateEnded(state) || len(participants) == 0 {
		return participants
	}
	out := append([]SoloParticipant(nil), participants...)
	for i := range out {
		if !SoloThreadStateEnded(out[i].Status) {
			out[i].Status = state
		}
	}
	return out
}

// SoloParticipantsEqual reports whether two participant lists say the same.
func SoloParticipantsEqual(a, b []SoloParticipant) bool {
	if len(a) != len(b) {
		return false
	}
	index := func(p *int) int {
		if p == nil {
			return -1
		}
		return *p
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.ID != y.ID || x.Name != y.Name || x.NameSet != y.NameSet || x.Kind != y.Kind || x.Status != y.Status ||
			index(x.NameIndex) != index(y.NameIndex) || index(x.AvatarIndex) != index(y.AvatarIndex) {
			return false
		}
	}
	return true
}

func cleanSoloParticipant(item SoloParticipant) SoloParticipant {
	out := SoloParticipant{
		ID:      strings.TrimSpace(item.ID),
		Name:    strings.TrimSpace(item.Name),
		NameSet: strings.TrimSpace(item.NameSet),
		Kind:    SoloParticipantSubagent,
		Status:  strings.ToLower(strings.TrimSpace(item.Status)),
	}
	if strings.TrimSpace(item.Kind) == SoloParticipantCoder {
		out.Kind = SoloParticipantCoder
	}
	if item.NameIndex != nil && *item.NameIndex >= 0 {
		index := *item.NameIndex
		out.NameIndex = &index
	}
	if item.AvatarIndex != nil && *item.AvatarIndex >= 0 {
		index := *item.AvatarIndex
		out.AvatarIndex = &index
	}
	return out
}

// updateSoloParticipant is have with what a later reading of the same worker says: its identity
// stays where the reading has none.
func updateSoloParticipant(have, next SoloParticipant) SoloParticipant {
	if next.Name != "" {
		have.Name = next.Name
	}
	if next.NameSet != "" {
		have.NameSet = next.NameSet
	}
	if next.NameIndex != nil {
		have.NameIndex = next.NameIndex
	}
	if next.AvatarIndex != nil {
		have.AvatarIndex = next.AvatarIndex
	}
	if next.Kind == SoloParticipantCoder {
		have.Kind = next.Kind
	}
	if next.Status != "" {
		have.Status = next.Status
	}
	return have
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
	// TaskID is, on a thread the reply started (or gave more work), the task that start made:
	// the one whose card and participants belong to this chip. It is set only when the reply
	// started exactly one task in the thread; a thread it only read, or started more than once,
	// has none, so no task is ever picked for it by its topic alone.
	TaskID string `json:"task_id,omitempty"`
	// Uses is what the run's successful tool calls did with the source, in the order each kind
	// of use first happened. Records from before it was kept have none.
	Uses []SoloSourceUse `json:"uses,omitempty"`
}

// What a run did with a source (SoloSourceUse.Action).
const (
	// SoloUseSelect: the run made the folder its workspace (workspace_use).
	SoloUseSelect = "select"
	// SoloUseReadFile and SoloUseWriteFile: read_file and write_file calls on files inside the workspace.
	SoloUseReadFile  = "read_file"
	SoloUseWriteFile = "write_file"
	// SoloUseShell: shell commands run in the workspace (bash, powershell).
	SoloUseShell = "shell"
	// SoloUseCoder: a coding agent worked in the workspace (coder).
	SoloUseCoder = "coder"
	// SoloUseSearch: a search of the memory or the journal.
	SoloUseSearch = "search"
	// SoloUseSave and SoloUseForget: the memory was added to or changed, or lost entries.
	SoloUseSave   = "save"
	SoloUseForget = "forget"
	// SoloUseRead: journal entries, a topic or a work thread were read.
	SoloUseRead = "read"
	// SoloUseStart: a work thread was started or given more work.
	SoloUseStart = "start"
)

// SoloSourceUseMaxCount is the most calls one SoloSourceUse counts; more stay at it.
const SoloSourceUseMaxCount = 9999

// SoloSourceUse is one kind of use a run made of a source, and how many successful calls made
// it. It names what was done only: never a call's arguments, its output, a command, a path, file
// content or a search's words.
type SoloSourceUse struct {
	Action string `json:"action"`
	Count  int    `json:"count"`
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
