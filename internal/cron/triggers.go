package cron

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Trigger kinds.
const (
	TriggerSchedule = "schedule"
	TriggerPoke     = "poke"
	TriggerMessage  = "message"
)

// Use modes, and how several "each" inputs join.
const (
	UseLatest = "latest"
	UseEach   = "each"
	UseFresh  = "fresh"

	JoinAll = "all"
	JoinAny = "any"
)

const (
	// MaxUses is how many jobs one job may use.
	MaxUses = 8
	// MaxTriggers is how many triggers one job may have.
	MaxTriggers = 16
	// LegacyScheduleTriggerID is the ID of the schedule trigger a job's at or cron makes, when the
	// job was written without a trigger list.
	LegacyScheduleTriggerID = "trg-schedule"
	// TriggerIDPrefix starts every trigger ID this version makes.
	TriggerIDPrefix = "trg-"
)

// Trigger is one way a job starts. ID names it within its job and never changes. Per kind:
// TriggerSchedule carries At or Cron, and TZ, with the rules the job's own at, cron and tz have;
// TriggerPoke carries nothing (POST /poke/{job_id} starts the job); TriggerMessage carries the
// Channel and ChatID whose messages start it (stored only: it does not fire yet).
type Trigger struct {
	ID      string `yaml:"id" json:"id"`
	Kind    string `yaml:"kind" json:"kind"`
	At      string `yaml:"at,omitempty" json:"at,omitempty"`
	Cron    string `yaml:"cron,omitempty" json:"cron,omitempty"`
	TZ      string `yaml:"tz,omitempty" json:"tz,omitempty"`
	Channel string `yaml:"channel,omitempty" json:"channel,omitempty"`
	ChatID  string `yaml:"chat_id,omitempty" json:"chat_id,omitempty"`
}

// Use is a job this one depends on. Mode is UseLatest, UseEach or UseFresh; only UseEach acts
// today: each run of JobID that ends done starts this job.
type Use struct {
	JobID string `yaml:"job_id" json:"job_id"`
	Mode  string `yaml:"mode" json:"mode"`
}

// ErrJobInUse is a delete of a job other jobs use. Nothing is deleted.
var ErrJobInUse = errors.New("job is used by other jobs")

// NewTriggerID returns a new trigger ID.
func NewTriggerID() string {
	return TriggerIDPrefix + strings.ReplaceAll(uuid.New().String(), "-", "")[:12]
}

// TriggersForTask is the task's triggers, never nil: its list, or for a legacy task (no list)
// the schedule trigger its at or cron makes.
func TriggersForTask(task Task) []Trigger {
	if task.Triggers != nil {
		return task.Triggers
	}
	at, cron := strings.TrimSpace(task.At), strings.TrimSpace(task.Cron)
	if at == "" && cron == "" {
		return []Trigger{}
	}
	return []Trigger{{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, At: at, Cron: cron, TZ: strings.TrimSpace(task.TZ)}}
}

// FindTrigger returns the task's trigger with that ID.
func FindTrigger(task Task, id string) (Trigger, bool) {
	id = strings.TrimSpace(id)
	for _, trigger := range TriggersForTask(task) {
		if trigger.ID == id {
			return trigger, id != ""
		}
	}
	return Trigger{}, false
}

// TriggerOfKind returns the task's first trigger of that kind.
func TriggerOfKind(task Task, kind string) (Trigger, bool) {
	for _, trigger := range TriggersForTask(task) {
		if trigger.Kind == kind {
			return trigger, true
		}
	}
	return Trigger{}, false
}

// JoinForTask is the task's join: JoinAny when it says so, otherwise JoinAll.
func JoinForTask(task Task) string {
	if strings.EqualFold(strings.TrimSpace(task.Join), JoinAny) {
		return JoinAny
	}
	return JoinAll
}

// EachInputs lists the jobs the task uses with mode "each", in order.
func EachInputs(task Task) []string {
	var out []string
	for _, use := range task.Uses {
		if use.Mode == UseEach {
			out = append(out, strings.TrimSpace(use.JobID))
		}
	}
	return out
}

// EachDependents lists the tasks that use job id with mode "each", in list order.
func EachDependents(tasks []Task, id string) []Task {
	id = strings.TrimSpace(id)
	var out []Task
	for _, task := range tasks {
		for _, input := range EachInputs(task) {
			if input == id {
				out = append(out, task)
				break
			}
		}
	}
	return out
}

// dependentsOf lists the IDs of the tasks that use job id, in any mode.
func dependentsOf(tasks []Task, id string) []string {
	var out []string
	for _, task := range tasks {
		for _, use := range task.Uses {
			if strings.TrimSpace(use.JobID) == id {
				out = append(out, strings.TrimSpace(task.ID))
				break
			}
		}
	}
	return out
}

// normalizeTask returns task as the store keeps it. stored is the job the list holds under the
// same ID, or nil.
//
// A task with a trigger list is taken as written: the list is authoritative, and at, cron and tz
// are set from its first schedule trigger (cleared without one). A task without the list is a
// legacy write, from a client that knows only at, cron and tz: those are its schedule, as before,
// and what such a client cannot see (the stored job's other triggers, its uses and its join) is
// kept as it is.
//
// One case between the two: a task that carries the stored job's trigger list unchanged, with an
// at, cron or tz that is not the stored one. That is a client that knows only those fields and
// sends back the rest of what it read, so its edit is the schedule: the first schedule trigger
// takes it.
func normalizeTask(task Task, stored *Task) Task {
	task.At, task.Cron, task.TZ = strings.TrimSpace(task.At), strings.TrimSpace(task.Cron), strings.TrimSpace(task.TZ)
	if task.Triggers != nil && stored != nil && (task.At != "" || task.Cron != "") {
		sent := make([]Trigger, 0, len(task.Triggers))
		for _, trigger := range task.Triggers {
			sent = append(sent, normalizeTrigger(trigger))
		}
		edited := task.At != strings.TrimSpace(stored.At) || task.Cron != strings.TrimSpace(stored.Cron) || task.TZ != strings.TrimSpace(stored.TZ)
		if edited && reflect.DeepEqual(sent, TriggersForTask(*stored)) {
			task.Triggers = withLegacySchedule(sent, task.At, task.Cron, task.TZ)
		}
	}
	if task.Triggers == nil {
		if stored == nil {
			// Always a schedule trigger, also without at and cron: such a task does not validate,
			// as it never did.
			task.Triggers = []Trigger{{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, At: task.At, Cron: task.Cron, TZ: task.TZ}}
		} else {
			task.Triggers = append([]Trigger{}, TriggersForTask(*stored)...)
			if task.At != strings.TrimSpace(stored.At) || task.Cron != strings.TrimSpace(stored.Cron) || task.TZ != strings.TrimSpace(stored.TZ) {
				task.Triggers = withLegacySchedule(task.Triggers, task.At, task.Cron, task.TZ)
			}
			if task.Uses == nil && strings.TrimSpace(task.Join) == "" {
				task.Uses = append([]Use(nil), stored.Uses...)
				task.Join = stored.Join
			}
		}
	}
	seen := map[string]bool{}
	triggers := make([]Trigger, 0, len(task.Triggers))
	for _, trigger := range task.Triggers {
		trigger = normalizeTrigger(trigger)
		if trigger.ID != "" {
			seen[trigger.ID] = true
		}
		triggers = append(triggers, trigger)
	}
	for i := range triggers {
		for triggers[i].ID == "" {
			if id := NewTriggerID(); !seen[id] {
				triggers[i].ID = id
				seen[id] = true
			}
		}
	}
	task.Triggers = triggers
	task.At, task.Cron, task.TZ = "", "", ""
	if first, ok := TriggerOfKind(task, TriggerSchedule); ok {
		task.At, task.Cron, task.TZ = first.At, first.Cron, first.TZ
	}
	var uses []Use
	for _, use := range task.Uses {
		use.JobID = strings.TrimSpace(use.JobID)
		use.Mode = strings.ToLower(strings.TrimSpace(use.Mode))
		if use.Mode == "" {
			use.Mode = UseLatest
		}
		uses = append(uses, use)
	}
	task.Uses = uses
	task.Join = strings.ToLower(strings.TrimSpace(task.Join))
	return task
}

// normalizeTrigger trims the trigger and drops the fields its kind does not carry.
func normalizeTrigger(trigger Trigger) Trigger {
	out := Trigger{ID: strings.TrimSpace(trigger.ID), Kind: strings.ToLower(strings.TrimSpace(trigger.Kind))}
	switch out.Kind {
	case TriggerSchedule:
		out.At, out.Cron, out.TZ = strings.TrimSpace(trigger.At), strings.TrimSpace(trigger.Cron), strings.TrimSpace(trigger.TZ)
	case TriggerMessage:
		out.Channel, out.ChatID = strings.ToLower(strings.TrimSpace(trigger.Channel)), strings.TrimSpace(trigger.ChatID)
	case TriggerPoke:
	default:
		// An unknown kind is kept whole, for the validation error that names it.
		out = trigger
		out.ID, out.Kind = strings.TrimSpace(trigger.ID), strings.TrimSpace(trigger.Kind)
	}
	return out
}

// withLegacySchedule returns triggers with the first schedule trigger set to at, cron and tz, its
// ID kept. Without a schedule trigger, one is put first.
func withLegacySchedule(triggers []Trigger, at, cron, tz string) []Trigger {
	out := append([]Trigger{}, triggers...)
	used := map[string]bool{}
	for i := range out {
		if out[i].Kind == TriggerSchedule {
			out[i].At, out[i].Cron, out[i].TZ = at, cron, tz
			return out
		}
		used[out[i].ID] = true
	}
	id := LegacyScheduleTriggerID
	for used[id] {
		id = NewTriggerID()
	}
	return append([]Trigger{{ID: id, Kind: TriggerSchedule, At: at, Cron: cron, TZ: tz}}, out...)
}

// validationTriggers is the list ValidateTask checks: the task's own, or for a legacy task its
// one schedule trigger, which must then have a time.
func validationTriggers(task Task) []Trigger {
	if task.Triggers != nil {
		return task.Triggers
	}
	return []Trigger{{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, At: strings.TrimSpace(task.At),
		Cron: strings.TrimSpace(task.Cron), TZ: strings.TrimSpace(task.TZ)}}
}

// validateTriggers checks each trigger's shape. The schedule errors read as the job's own at and
// cron errors always did.
func validateTriggers(id string, triggers []Trigger) error {
	if len(triggers) > MaxTriggers {
		return fmt.Errorf("task %s has %d triggers; the limit is %d", id, len(triggers), MaxTriggers)
	}
	seen := map[string]bool{}
	pokes := 0
	for _, trigger := range triggers {
		triggerID := strings.TrimSpace(trigger.ID)
		if triggerID != "" {
			if strings.ContainsAny(triggerID, " \t\r\n") {
				return fmt.Errorf("task %s: trigger id must not contain whitespace: %s", id, triggerID)
			}
			if seen[triggerID] {
				return fmt.Errorf("task %s: duplicate trigger id: %s", id, triggerID)
			}
			seen[triggerID] = true
		}
		switch strings.TrimSpace(trigger.Kind) {
		case TriggerSchedule:
			loc, err := taskLocation(trigger.TZ)
			if err != nil {
				return err
			}
			atRaw, cronRaw := strings.TrimSpace(trigger.At), strings.TrimSpace(trigger.Cron)
			if (atRaw == "") == (cronRaw == "") {
				return fmt.Errorf("task %s must use exactly one of at or cron", id)
			}
			if atRaw != "" {
				if _, err := time.ParseInLocation(TimestampLayout, atRaw, loc); err != nil {
					return fmt.Errorf("invalid at for task %s: %s", id, atRaw)
				}
			} else if _, err := ParseExpression(cronRaw); err != nil {
				return fmt.Errorf("invalid cron for task %s: %w", id, err)
			}
		case TriggerPoke:
			pokes++
			if pokes > 1 {
				return fmt.Errorf("task %s has more than one poke trigger", id)
			}
		case TriggerMessage:
			channel := strings.TrimSpace(trigger.Channel)
			if channel == "" {
				return fmt.Errorf("task %s: a message trigger needs a channel", id)
			}
			if strings.ContainsAny(channel, " \t\r\n") {
				return fmt.Errorf("task %s: message trigger channel must not contain whitespace: %s", id, channel)
			}
			if strings.TrimSpace(trigger.ChatID) == "" {
				return fmt.Errorf("task %s: a message trigger needs a chat_id", id)
			}
		default:
			return fmt.Errorf("task %s: unknown trigger kind %q (want schedule, poke or message)", id, strings.TrimSpace(trigger.Kind))
		}
	}
	return nil
}

// validateUsesShape checks what one task's uses and join say on their own. Whether the jobs they
// name exist, and whether the links loop, is checked on the whole list (validateUsesGraph).
func validateUsesShape(task Task) error {
	id := strings.TrimSpace(task.ID)
	if len(task.Uses) > MaxUses {
		return fmt.Errorf("task %s uses %d jobs; the limit is %d", id, len(task.Uses), MaxUses)
	}
	seen := map[string]bool{}
	for _, use := range task.Uses {
		jobID := strings.TrimSpace(use.JobID)
		if jobID == "" {
			return fmt.Errorf("task %s: a use needs a job_id", id)
		}
		if jobID == id {
			return fmt.Errorf("task %s cannot use itself", id)
		}
		if seen[jobID] {
			return fmt.Errorf("task %s uses job %s more than once", id, jobID)
		}
		seen[jobID] = true
		switch strings.TrimSpace(use.Mode) {
		case UseLatest, UseEach, UseFresh:
		default:
			return fmt.Errorf("task %s: unknown use mode %q for job %s (want latest, each or fresh)", id, strings.TrimSpace(use.Mode), jobID)
		}
	}
	switch strings.TrimSpace(task.Join) {
	case "", JoinAll, JoinAny:
	default:
		return fmt.Errorf("task %s: unknown join %q (want all or any)", id, strings.TrimSpace(task.Join))
	}
	return nil
}

// validateUsesGraph checks the links between the list's tasks: every used job is in the list, and
// no job reaches itself through the jobs it uses. The error names the loop: "a -> b -> a", each
// job using the next.
func validateUsesGraph(tasks []Task) error {
	uses := make(map[string][]string, len(tasks))
	order := make([]string, 0, len(tasks))
	for _, task := range tasks {
		id := strings.TrimSpace(task.ID)
		order = append(order, id)
		for _, use := range task.Uses {
			uses[id] = append(uses[id], strings.TrimSpace(use.JobID))
		}
	}
	known := make(map[string]bool, len(order))
	for _, id := range order {
		known[id] = true
	}
	for _, id := range order {
		for _, used := range uses[id] {
			if !known[used] {
				return fmt.Errorf("task %s uses unknown job: %s", id, used)
			}
		}
	}
	const (
		visiting = 1
		done     = 2
	)
	state := map[string]int{}
	var path []string
	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case done:
			return nil
		case visiting:
			start := 0
			for i, on := range path {
				if on == id {
					start = i
					break
				}
			}
			loop := append(append([]string{}, path[start:]...), id)
			return fmt.Errorf("jobs use each other in a loop: %s", strings.Join(loop, " -> "))
		}
		state[id] = visiting
		path = append(path, id)
		for _, used := range uses[id] {
			if err := visit(used); err != nil {
				return err
			}
		}
		path = path[:len(path)-1]
		state[id] = done
		return nil
	}
	for _, id := range order {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

// jobInUseError is the refusal to delete job id while the tasks named use it.
func jobInUseError(id string, dependents []string) error {
	return fmt.Errorf("%w: %s is used by %s; remove it from their uses first", ErrJobInUse, id, strings.Join(dependents, ", "))
}
