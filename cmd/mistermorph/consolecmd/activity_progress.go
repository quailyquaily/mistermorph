package consolecmd

import (
	"encoding/json"
	"reflect"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

const (
	consoleActivityHistoryLimit   = 24
	consoleActivityOutputMaxChars = 6000
	// consoleActivityChildLimit bounds the nested calls kept under one codemode entry.
	consoleActivityChildLimit = 12
	// consoleActivityMessageLimit bounds the Agent Link messages kept under one agent_send entry,
	// and consoleActivityMessageMaxChars the length of each.
	consoleActivityMessageLimit    = 12
	consoleActivityMessageMaxChars = 4000
	// consoleActivityWorkerLimit bounds the workers kept in the roster; the oldest go first.
	consoleActivityWorkerLimit = 32
)

type consoleActivityProgress struct {
	Current *consoleActivityEntry  `json:"current,omitempty"`
	History []consoleActivityEntry `json:"history,omitempty"`
	// Workers are the subagents and coders the task started, in start order. Unlike History, a
	// worker stays here after its entries scroll out, so the roster lists every one.
	Workers []consoleActivityWorker `json:"workers,omitempty"`
	// WorkersOmitted counts the oldest workers dropped to stay within consoleActivityWorkerLimit.
	WorkersOmitted int `json:"workers_omitted,omitempty"`
	// droppedWorkers keeps those IDs, so an entry still in the history does not add one back.
	droppedWorkers map[string]bool
}

// consoleActivityWorker is one subagent or coder in the task's roster, with its latest state and
// output.
type consoleActivityWorker struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// NameIndex and AvatarIndex are the worker's allocated name and logo style (see
	// agent.WorkerMetadata); older records have neither.
	NameIndex   *int `json:"name_index,omitempty"`
	AvatarIndex *int `json:"avatar_index,omitempty"`
	// Kind is "coder" for a coder call, else "subagent".
	Kind   string `json:"kind"`
	Status string `json:"status,omitempty"`
	// ActivityID is the spawn or coder call that started the worker.
	ActivityID string `json:"activity_id,omitempty"`
	At         string `json:"at,omitempty"`
	Stream     string `json:"stream,omitempty"`
	// Output is the tail of what the worker printed while it ran (coders).
	Output string `json:"output,omitempty"`
	// Result is the worker's final answer, from the result its spawn or coder call returned.
	Result    string                `json:"result,omitempty"`
	Summary   string                `json:"summary,omitempty"`
	Error     string                `json:"error,omitempty"`
	Processes []agent.WorkerProcess `json:"processes,omitempty"`

	// statusRank is how much the source of Status counts; see consoleWorkerStatusRank.
	statusRank int
}

// The sources of a worker's status, from least to most trusted. A spawn call reports done once
// it has handed back its subtask's result, even a failed one, so it never overrides the subtask,
// and the result's own status overrides both.
const (
	consoleWorkerStatusFromCall = iota + 1
	consoleWorkerStatusFromSubtask
	consoleWorkerStatusFromResult
)

type consoleActivityEntry struct {
	Worker     *agent.WorkerMetadata `json:"worker,omitempty"`
	ID         string                `json:"id"`
	Kind       string                `json:"kind"`
	Name       string                `json:"name,omitempty"`
	Status     string                `json:"status,omitempty"`
	At         string                `json:"at,omitempty"`
	Stream     string                `json:"stream,omitempty"`
	Output     string                `json:"output,omitempty"`
	Args       map[string]any        `json:"args,omitempty"`
	Summary    string                `json:"summary,omitempty"`
	Error      string                `json:"error,omitempty"`
	TaskID     string                `json:"task_id,omitempty"`
	Mode       string                `json:"mode,omitempty"`
	Profile    string                `json:"profile,omitempty"`
	OutputKind string                `json:"output_kind,omitempty"`
	// Children are the tool calls a codemode script made, most recent last; ChildrenOmitted
	// counts earlier ones dropped to stay within consoleActivityChildLimit.
	Children        []consoleActivityEntry `json:"children,omitempty"`
	ChildrenOmitted int                    `json:"children_omitted,omitempty"`
	// Messages are what agent_send exchanged with another agent over Agent Link, in order.
	Messages []consoleActivityMessage `json:"messages,omitempty"`
}

// consoleActivityMessage is one message between this agent and another over Agent Link.
type consoleActivityMessage struct {
	// Direction is "sent", "reply", or "pending" for an answer that has not come yet.
	Direction string `json:"direction"`
	Peer      string `json:"peer,omitempty"`
	Text      string `json:"text,omitempty"`
	At        string `json:"at,omitempty"`
}

func cloneConsoleActivityProgress(progress *consoleActivityProgress) *consoleActivityProgress {
	if progress == nil {
		return nil
	}
	out := &consoleActivityProgress{
		Current: cloneConsoleActivityEntry(progress.Current),
		History: make([]consoleActivityEntry, 0, len(progress.History)),
	}
	for _, worker := range progress.Workers {
		worker.Processes = append([]agent.WorkerProcess(nil), worker.Processes...)
		out.Workers = append(out.Workers, worker)
	}
	out.WorkersOmitted = progress.WorkersOmitted
	if len(progress.droppedWorkers) > 0 {
		out.droppedWorkers = make(map[string]bool, len(progress.droppedWorkers))
		for id := range progress.droppedWorkers {
			out.droppedWorkers[id] = true
		}
	}
	for _, entry := range progress.History {
		cloned := cloneConsoleActivityEntry(&entry)
		if cloned == nil {
			continue
		}
		out.History = append(out.History, *cloned)
	}
	if out.Current == nil && len(out.History) > 0 {
		last := out.History[len(out.History)-1]
		out.Current = cloneConsoleActivityEntry(&last)
	}
	if out.Current == nil && len(out.History) == 0 && len(out.Workers) == 0 {
		return nil
	}
	return out
}

func cloneConsoleActivityEntry(entry *consoleActivityEntry) *consoleActivityEntry {
	if entry == nil {
		return nil
	}
	out := *entry
	out.Worker = mergeConsoleWorker(nil, entry.Worker)
	if len(entry.Args) > 0 {
		out.Args = cloneConsoleArgs(entry.Args)
	}
	if len(entry.Children) > 0 {
		out.Children = make([]consoleActivityEntry, 0, len(entry.Children))
		for i := range entry.Children {
			out.Children = append(out.Children, *cloneConsoleActivityEntry(&entry.Children[i]))
		}
	}
	if len(entry.Messages) > 0 {
		out.Messages = append([]consoleActivityMessage(nil), entry.Messages...)
	}
	return &out
}

func cloneConsoleArgs(args map[string]any) map[string]any {
	if len(args) == 0 {
		return nil
	}
	out := make(map[string]any, len(args))
	for key, value := range args {
		out[key] = value
	}
	return out
}

func updateConsoleActivityProgress(progress *consoleActivityProgress, event agent.Event) (*consoleActivityProgress, bool) {
	if progress == nil {
		// The entry updates fill this in place; an update that adds nothing still clones to nil.
		progress = &consoleActivityProgress{}
	}
	_, changed := updateConsoleActivityEntries(progress, event)
	if syncConsoleActivityWorkers(progress, event.Worker) {
		changed = true
	}
	if applyConsoleWorkerEvent(progress, event) {
		changed = true
	}
	return cloneConsoleActivityProgress(progress), changed
}

func updateConsoleActivityEntries(progress *consoleActivityProgress, event agent.Event) (*consoleActivityProgress, bool) {
	if event.Kind == agent.EventKindWorkerProcess {
		changed := updateConsoleWorkerEntries(progress, event.Worker)
		return cloneConsoleActivityProgress(progress), changed
	}
	updateConsoleWorkerEntries(progress, event.Worker)
	if strings.TrimSpace(event.Kind) == agent.EventKindToolOutput {
		return updateConsoleActivityOutput(progress, event)
	}

	entry := buildConsoleActivityEntry(event)
	if entry == nil {
		return cloneConsoleActivityProgress(progress), false
	}
	if progress == nil {
		progress = &consoleActivityProgress{}
	}
	if parentID := strings.TrimSpace(event.ParentActivityID); parentID != "" {
		for i := range progress.History {
			if progress.History[i].ID == parentID {
				progress.History[i] = mergeConsoleActivityChild(progress.History[i], *entry)
				progress.Current = cloneConsoleActivityEntry(&progress.History[i])
				return cloneConsoleActivityProgress(progress), true
			}
		}
		// The parent scrolled out of the history: show the call on its own.
	}

	index := -1
	for i := range progress.History {
		if progress.History[i].ID == entry.ID {
			index = i
			break
		}
	}
	if index >= 0 {
		progress.History[index] = mergeConsoleActivityEntry(progress.History[index], *entry)
		progress.Current = cloneConsoleActivityEntry(&progress.History[index])
		return cloneConsoleActivityProgress(progress), true
	}

	progress.History = append(progress.History, *entry)
	if len(progress.History) > consoleActivityHistoryLimit {
		progress.History = append([]consoleActivityEntry(nil), progress.History[len(progress.History)-consoleActivityHistoryLimit:]...)
	}
	last := progress.History[len(progress.History)-1]
	progress.Current = cloneConsoleActivityEntry(&last)
	return cloneConsoleActivityProgress(progress), true
}

func updateConsoleActivityOutput(progress *consoleActivityProgress, event agent.Event) (*consoleActivityProgress, bool) {
	if direction, ok := consoleAgentLinkDirection(event.Stream); ok {
		return appendConsoleActivityMessage(progress, event, direction)
	}
	if progress == nil || event.Text == "" || strings.TrimSpace(event.ToolName) != "coder" {
		return cloneConsoleActivityProgress(progress), false
	}
	target, ok := consoleActivityOutputTarget(progress, event)
	if !ok {
		return cloneConsoleActivityProgress(progress), false
	}

	entry := progress.entryAt(target)
	if stream := strings.TrimSpace(event.Stream); stream != "" {
		entry.Stream = stream
	}
	if status := strings.TrimSpace(event.Status); status != "" {
		entry.Status = status
	}
	entry.At = time.Now().Format(time.RFC3339Nano)
	entry.Output = appendConsoleTail(entry.Output, event.Text, consoleActivityOutputMaxChars)
	progress.Current = cloneConsoleActivityEntry(&progress.History[target.index])
	return cloneConsoleActivityProgress(progress), true
}

// consoleAgentLinkDirection maps the stream of an agent_send tool_output event to a message direction.
func consoleAgentLinkDirection(stream string) (string, bool) {
	switch strings.TrimSpace(stream) {
	case builtin.AgentLinkStreamSent:
		return "sent", true
	case builtin.AgentLinkStreamReply:
		return "reply", true
	case builtin.AgentLinkStreamPending:
		return "pending", true
	}
	return "", false
}

// appendConsoleActivityMessage adds a message agent_send exchanged over Agent Link to its call.
func appendConsoleActivityMessage(progress *consoleActivityProgress, event agent.Event, direction string) (*consoleActivityProgress, bool) {
	target, ok := consoleActivityOutputTarget(progress, event)
	if !ok {
		return cloneConsoleActivityProgress(progress), false
	}
	entry := progress.entryAt(target)
	now := time.Now().Format(time.RFC3339Nano)
	if len(entry.Messages) >= consoleActivityMessageLimit {
		entry.Messages = entry.Messages[len(entry.Messages)-consoleActivityMessageLimit+1:]
	}
	entry.Messages = append(append([]consoleActivityMessage(nil), entry.Messages...), consoleActivityMessage{
		Direction: direction,
		Peer:      strings.TrimSpace(event.Summary),
		Text:      truncateConsoleActivityMessage(event.Text),
		At:        now,
	})
	entry.At = now
	progress.Current = cloneConsoleActivityEntry(&progress.History[target.index])
	return cloneConsoleActivityProgress(progress), true
}

func truncateConsoleActivityMessage(text string) string {
	text = strings.TrimSpace(text)
	if runes := []rune(text); len(runes) > consoleActivityMessageMaxChars {
		return string(runes[:consoleActivityMessageMaxChars]) + "…"
	}
	return text
}

// consoleActivityTarget is where a tool call sits in the history: History[index], or, for a call a
// codemode script made, History[index].Children[child].
type consoleActivityTarget struct {
	index int
	child int
}

func (p *consoleActivityProgress) entryAt(target consoleActivityTarget) *consoleActivityEntry {
	if target.child >= 0 {
		return &p.History[target.index].Children[target.child]
	}
	return &p.History[target.index]
}

// consoleActivityOutputTarget finds the call a tool_output event belongs to: the one with its
// activity ID, else the latest running call of its tool, looking into the calls codemode scripts
// made as well.
func consoleActivityOutputTarget(progress *consoleActivityProgress, event agent.Event) (consoleActivityTarget, bool) {
	if progress == nil {
		return consoleActivityTarget{}, false
	}
	if id := strings.TrimSpace(event.ActivityID); id != "" {
		for i := range progress.History {
			if progress.History[i].ID == id {
				return consoleActivityTarget{index: i, child: -1}, true
			}
			for j := range progress.History[i].Children {
				if progress.History[i].Children[j].ID == id {
					return consoleActivityTarget{index: i, child: j}, true
				}
			}
		}
	}

	toolName := strings.TrimSpace(event.ToolName)
	running := func(entry consoleActivityEntry) bool {
		if strings.TrimSpace(entry.Kind) != "tool" {
			return false
		}
		if toolName != "" && strings.TrimSpace(entry.Name) != toolName {
			return false
		}
		switch strings.TrimSpace(entry.Status) {
		case "done", "failed", "canceled":
			return false
		}
		return true
	}
	for i := len(progress.History) - 1; i >= 0; i-- {
		children := progress.History[i].Children
		for j := len(children) - 1; j >= 0; j-- {
			if running(children[j]) {
				return consoleActivityTarget{index: i, child: j}, true
			}
		}
		if running(progress.History[i]) {
			return consoleActivityTarget{index: i, child: -1}, true
		}
	}
	return consoleActivityTarget{}, false
}

func buildConsoleActivityEntry(event agent.Event) *consoleActivityEntry {
	id := strings.TrimSpace(event.ActivityID)
	if id == "" {
		id = strings.TrimSpace(event.TaskID)
	}
	if id == "" {
		return nil
	}

	entry := &consoleActivityEntry{
		ID:         id,
		Worker:     mergeConsoleWorker(nil, event.Worker),
		Status:     strings.TrimSpace(event.Status),
		At:         time.Now().Format(time.RFC3339Nano),
		Summary:    strings.TrimSpace(event.Summary),
		Error:      strings.TrimSpace(event.Error),
		TaskID:     strings.TrimSpace(event.TaskID),
		Mode:       strings.TrimSpace(event.Mode),
		Profile:    strings.TrimSpace(event.Profile),
		OutputKind: strings.TrimSpace(event.OutputKind),
		Args:       cloneConsoleArgs(event.Args),
	}

	switch strings.TrimSpace(event.Kind) {
	case agent.EventKindLLMRetry:
		entry.Kind = "retry"
		entry.Name = strings.TrimSpace(event.Text)
	case agent.EventKindToolStart, agent.EventKindToolDone:
		entry.Kind = "tool"
		entry.Name = strings.TrimSpace(event.ToolName)
	case agent.EventKindSubtaskStart, agent.EventKindSubtaskDone:
		entry.Kind = "subtask"
		entry.Name = strings.TrimSpace(event.TaskID)
	default:
		return nil
	}

	if entry.Kind == "tool" && entry.Name == "" {
		entry.Name = "tool"
	}
	if entry.Kind == "subtask" && entry.Name == "" {
		entry.Name = "subtask"
	}
	return entry
}

// mergeConsoleActivityChild records a nested call under its codemode entry, so a script takes one
// history slot however many calls it makes.
func mergeConsoleActivityChild(parent consoleActivityEntry, child consoleActivityEntry) consoleActivityEntry {
	for i := range parent.Children {
		if parent.Children[i].ID == child.ID {
			parent.Children[i] = mergeConsoleActivityEntry(parent.Children[i], child)
			return parent
		}
	}
	parent.Children = append(parent.Children, child)
	if extra := len(parent.Children) - consoleActivityChildLimit; extra > 0 {
		parent.Children = append([]consoleActivityEntry(nil), parent.Children[extra:]...)
		parent.ChildrenOmitted += extra
	}
	return parent
}

func mergeConsoleActivityEntry(base consoleActivityEntry, update consoleActivityEntry) consoleActivityEntry {
	base.Worker = mergeConsoleWorker(base.Worker, update.Worker)
	if strings.TrimSpace(update.Kind) != "" {
		base.Kind = strings.TrimSpace(update.Kind)
	}
	if strings.TrimSpace(update.Name) != "" {
		base.Name = strings.TrimSpace(update.Name)
	}
	if strings.TrimSpace(update.Status) != "" {
		base.Status = strings.TrimSpace(update.Status)
	}
	if strings.TrimSpace(update.At) != "" {
		base.At = strings.TrimSpace(update.At)
	}
	if strings.TrimSpace(update.Stream) != "" {
		base.Stream = strings.TrimSpace(update.Stream)
	}
	if update.Output != "" {
		base.Output = update.Output
	}
	if len(update.Args) > 0 {
		base.Args = cloneConsoleArgs(update.Args)
	}
	if strings.TrimSpace(update.Summary) != "" {
		base.Summary = strings.TrimSpace(update.Summary)
	}
	if strings.TrimSpace(update.Error) != "" {
		base.Error = strings.TrimSpace(update.Error)
	}
	if strings.TrimSpace(update.TaskID) != "" {
		base.TaskID = strings.TrimSpace(update.TaskID)
	}
	if strings.TrimSpace(update.Mode) != "" {
		base.Mode = strings.TrimSpace(update.Mode)
	}
	if strings.TrimSpace(update.Profile) != "" {
		base.Profile = strings.TrimSpace(update.Profile)
	}
	if strings.TrimSpace(update.OutputKind) != "" {
		base.OutputKind = strings.TrimSpace(update.OutputKind)
	}
	return base
}

// Merge snapshots by process identity: output callbacks may deliver older snapshots after
// a process-start event. Never discard a PID already observed for this worker.
func mergeConsoleWorker(base, update *agent.WorkerMetadata) *agent.WorkerMetadata {
	if base == nil {
		base = update
	}
	if base == nil {
		return nil
	}
	out := *base
	out.Processes = append([]agent.WorkerProcess(nil), base.Processes...)
	if update != nil && update.ID == out.ID {
		for _, process := range update.Processes {
			if process.PID <= 0 {
				continue
			}
			found := false
			for _, existing := range out.Processes {
				if existing == process {
					found = true
					break
				}
			}
			if !found {
				out.Processes = append(out.Processes, process)
			}
		}
	}
	return &out
}

func updateConsoleWorkerEntries(progress *consoleActivityProgress, worker *agent.WorkerMetadata) bool {
	if progress == nil || worker == nil {
		return false
	}
	changed := false
	var visit func(*consoleActivityEntry)
	visit = func(entry *consoleActivityEntry) {
		if entry == nil {
			return
		}
		if entry.Worker != nil && entry.Worker.ID == worker.ID {
			entry.Worker = mergeConsoleWorker(entry.Worker, worker)
			changed = true
		}
		for i := range entry.Children {
			visit(&entry.Children[i])
		}
	}
	for i := range progress.History {
		visit(&progress.History[i])
	}
	visit(progress.Current)
	return changed
}

// consoleWorkerRoot reports whether entry started a worker: a spawn or coder call, or the
// subtask a spawn runs.
func consoleWorkerRoot(entry *consoleActivityEntry) bool {
	if entry == nil {
		return false
	}
	switch strings.TrimSpace(entry.Kind) {
	case "subtask":
		return true
	case "tool":
		name := strings.TrimSpace(entry.Name)
		return name == "spawn" || name == "coder"
	}
	return false
}

// syncConsoleActivityWorkers updates the roster from the entries that started workers, and merges
// the processes an event reports into its worker. Workers are never removed, so a worker stays
// listed after its entries scroll out of the history.
func syncConsoleActivityWorkers(progress *consoleActivityProgress, eventWorker *agent.WorkerMetadata) bool {
	if progress == nil {
		return false
	}
	before := cloneConsoleActivityProgress(progress)
	index := func(id string) int {
		for i := range progress.Workers {
			if progress.Workers[i].ID == id {
				return i
			}
		}
		return -1
	}
	byActivity := func(activityID string) int {
		if activityID == "" {
			return -1
		}
		for i := range progress.Workers {
			if progress.Workers[i].ActivityID == activityID {
				return i
			}
		}
		return -1
	}
	visit := func(entry *consoleActivityEntry) {
		if !consoleWorkerRoot(entry) {
			return
		}
		i := -1
		if entry.Worker != nil && strings.TrimSpace(entry.Worker.ID) != "" {
			if progress.droppedWorkers[entry.Worker.ID] {
				return
			}
			i = index(entry.Worker.ID)
			if i < 0 {
				kind := "subagent"
				if strings.TrimSpace(entry.Name) == "coder" && entry.Kind == "tool" {
					kind = "coder"
				}
				progress.Workers = append(progress.Workers, consoleActivityWorker{
					ID:   entry.Worker.ID,
					Name: entry.Worker.Name,
					Kind: kind,
				})
				i = len(progress.Workers) - 1
			}
		} else if entry.Kind == "tool" {
			// A completion that arrived without worker metadata still belongs to its call.
			i = byActivity(entry.ID)
		}
		if i < 0 {
			return
		}
		worker := &progress.Workers[i]
		if entry.Kind == "tool" && worker.ActivityID == "" {
			worker.ActivityID = entry.ID
		}
		if entry.Worker != nil {
			if name := strings.TrimSpace(entry.Worker.Name); name != "" {
				worker.Name = name
			}
			if entry.Worker.NameIndex != nil {
				worker.NameIndex = cloneConsoleIndex(entry.Worker.NameIndex)
			}
			if entry.Worker.AvatarIndex != nil {
				worker.AvatarIndex = cloneConsoleIndex(entry.Worker.AvatarIndex)
			}
			worker.Processes = mergeConsoleWorker(&agent.WorkerMetadata{ID: worker.ID, Processes: worker.Processes},
				&agent.WorkerMetadata{ID: worker.ID, Processes: entry.Worker.Processes}).Processes
		}
		rank := consoleWorkerStatusFromCall
		if entry.Kind == "subtask" {
			rank = consoleWorkerStatusFromSubtask
		}
		setConsoleWorkerStatus(worker, entry.Status, rank)
		if at := strings.TrimSpace(entry.At); at != "" {
			worker.At = at
		}
		if stream := strings.TrimSpace(entry.Stream); stream != "" {
			worker.Stream = stream
		}
		if summary := strings.TrimSpace(entry.Summary); summary != "" {
			worker.Summary = summary
		}
		if errText := strings.TrimSpace(entry.Error); errText != "" {
			worker.Error = errText
		}
	}
	for i := range progress.History {
		visit(&progress.History[i])
		for j := range progress.History[i].Children {
			visit(&progress.History[i].Children[j])
		}
	}
	if eventWorker != nil {
		if i := index(eventWorker.ID); i >= 0 {
			worker := &progress.Workers[i]
			worker.Processes = mergeConsoleWorker(&agent.WorkerMetadata{ID: worker.ID, Processes: worker.Processes},
				&agent.WorkerMetadata{ID: worker.ID, Processes: eventWorker.Processes}).Processes
		}
	}
	if extra := len(progress.Workers) - consoleActivityWorkerLimit; extra > 0 {
		if progress.droppedWorkers == nil {
			progress.droppedWorkers = map[string]bool{}
		}
		for _, worker := range progress.Workers[:extra] {
			progress.droppedWorkers[worker.ID] = true
		}
		progress.Workers = append([]consoleActivityWorker(nil), progress.Workers[extra:]...)
		progress.WorkersOmitted += extra
	}
	return !reflect.DeepEqual(before, cloneConsoleActivityProgress(progress))
}

func cloneConsoleIndex(index *int) *int {
	if index == nil {
		return nil
	}
	out := *index
	return &out
}

// setConsoleWorkerStatus records status unless a more trusted source already set the worker's.
func setConsoleWorkerStatus(worker *consoleActivityWorker, status string, rank int) {
	status = strings.TrimSpace(status)
	if status == "" || rank < worker.statusRank {
		return
	}
	worker.Status = status
	worker.statusRank = rank
}

// consoleWorkerForEvent finds the roster worker an event belongs to: by its worker metadata, else
// by the call that started the worker.
func consoleWorkerForEvent(progress *consoleActivityProgress, event agent.Event) *consoleActivityWorker {
	if event.Worker != nil {
		if id := strings.TrimSpace(event.Worker.ID); id != "" {
			for i := range progress.Workers {
				if progress.Workers[i].ID == id {
					return &progress.Workers[i]
				}
			}
		}
	}
	if id := strings.TrimSpace(event.ActivityID); id != "" {
		for i := range progress.Workers {
			if progress.Workers[i].ActivityID == id {
				return &progress.Workers[i]
			}
		}
	}
	return nil
}

// applyConsoleWorkerEvent records what an event says about a worker directly in the roster, so it
// does not depend on the worker's entries still being in the history: a coder's output, and the
// result a spawn or coder call returned.
func applyConsoleWorkerEvent(progress *consoleActivityProgress, event agent.Event) bool {
	if progress == nil || len(progress.Workers) == 0 {
		return false
	}
	tool := strings.TrimSpace(event.ToolName)
	switch strings.TrimSpace(event.Kind) {
	case agent.EventKindToolOutput:
		if tool != "coder" || event.Text == "" {
			return false
		}
		if _, agentLink := consoleAgentLinkDirection(event.Stream); agentLink {
			return false
		}
		worker := consoleWorkerForEvent(progress, event)
		if worker == nil {
			return false
		}
		worker.Output = appendConsoleTail(worker.Output, event.Text, consoleActivityOutputMaxChars)
		if stream := strings.TrimSpace(event.Stream); stream != "" {
			worker.Stream = stream
		}
		worker.At = time.Now().Format(time.RFC3339Nano)
		return true
	case agent.EventKindToolDone:
		if tool != "spawn" && tool != "coder" {
			return false
		}
		worker := consoleWorkerForEvent(progress, event)
		if worker == nil {
			return false
		}
		result, ok := parseConsoleSubtaskResult(event.Text)
		if !ok {
			return false
		}
		before := *worker
		setConsoleWorkerStatus(worker, result.Status, consoleWorkerStatusFromResult)
		if text := consoleSubtaskResultText(result); text != "" {
			worker.Result = text
		}
		if summary := strings.TrimSpace(result.Summary); summary != "" {
			worker.Summary = summary
		}
		if errText := strings.TrimSpace(result.Error); errText != "" {
			worker.Error = errText
		}
		return !reflect.DeepEqual(before, *worker)
	}
	return false
}

// parseConsoleSubtaskResult reads the result envelope a spawn or coder call returns.
func parseConsoleSubtaskResult(text string) (agent.SubtaskResult, bool) {
	var result agent.SubtaskResult
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "{") || json.Unmarshal([]byte(text), &result) != nil {
		return agent.SubtaskResult{}, false
	}
	if strings.TrimSpace(result.Status) == "" {
		return agent.SubtaskResult{}, false
	}
	return result, true
}

// consoleSubtaskResultText is a subtask's final output as text: text output as it is, structured
// output as indented JSON, kept to its first consoleActivityOutputMaxChars characters.
func consoleSubtaskResultText(result agent.SubtaskResult) string {
	var text string
	switch output := result.Output.(type) {
	case nil:
		return ""
	case string:
		text = output
	default:
		raw, err := json.MarshalIndent(output, "", "  ")
		if err != nil {
			return ""
		}
		text = string(raw)
	}
	if strings.TrimSpace(text) == "" {
		return ""
	}
	if runes := []rune(text); len(runes) > consoleActivityOutputMaxChars {
		text = string(runes[:consoleActivityOutputMaxChars]) + "\n..."
	}
	return text
}
