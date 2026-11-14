package daemonruntime

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentlink"
)

// The Runtime overview's running task counts (`running_tasks` in GET /overview): how many tasks
// run right now, per entry of the Runtime panel's channel list. The Console's runtime has a
// "console" and a "cli" entry beside its messaging channels; a channel runtime has its own.
//
// A task is running when its status is TaskRunning: it holds a run that has started and not
// ended. A run waiting on its person's answer (ask_user) is still running. Queued tasks (waiting
// for a slot), pending ones (stopped on an approval) and finished ones (done, failed, canceled)
// are not. A message steered into a running task (SteerTargetTaskID) is part of that task's run,
// so it does not count again.
//
// Each running task counts under one entry at most, by what started it (its trigger), never
// under two. Background work that no channel started (the awareness loop, TODO runs, heartbeats
// in the Console, Agent Link messages) counts under none.
//
// An entry in `running_tasks` is a count that was taken; an entry that is missing is unknown.
const (
	RunningTasksConsole = "console"
	RunningTasksCLI     = "cli"
)

// consoleCLIChatTriggerRef marks a task that the chat command sent to a runtime's API.
const consoleCLIChatTriggerRef = "cli/chat"

// messagingChannelModes are the runtime modes that are a messaging channel of their own.
var messagingChannelModes = map[string]bool{
	"telegram": true, "slack": true, "line": true, "lark": true, "mixin": true, "discord": true,
	"wechat": true, "whatsapp": true, "bluesky": true, "x": true,
}

// RunningTaskCounter is a task store that counts its running tasks under the entries `entry`
// names for their triggers ("" counts under none). The counts hold every entry seen, and only
// those: an entry with no running task is absent.
type RunningTaskCounter interface {
	CountRunningTasks(entry func(TaskTrigger) string) (map[string]int, error)
}

// IsRunningExecution reports whether task is a run in progress of its own.
func IsRunningExecution(task TaskInfo) bool {
	return task.Status == TaskRunning && strings.TrimSpace(task.SteerTargetTaskID) == ""
}

// ConsoleRunningTaskEntry is where a task of the Console's task store counts: a task sent from
// the chat command, run by its own process (source "chat") or sent to the Console's API
// (source "ui", ref "cli/chat"), counts under "cli"; one sent from the Console's chat under
// "console"; the rest (awareness, TODO runs, Agent Link) under none.
func ConsoleRunningTaskEntry(trigger TaskTrigger) string {
	switch strings.TrimSpace(trigger.Source) {
	case "chat":
		return RunningTasksCLI
	case "ui":
		if strings.TrimSpace(trigger.Ref) == consoleCLIChatTriggerRef {
			return RunningTasksCLI
		}
		return RunningTasksConsole
	}
	return ""
}

// ChannelRunningTaskEntry is where a task of a channel runtime's task store counts: under the
// channel, except a message from another agent over Agent Link, which runs beside the channel
// in the same store.
func ChannelRunningTaskEntry(channel string) func(TaskTrigger) string {
	channel = strings.ToLower(strings.TrimSpace(channel))
	return func(trigger TaskTrigger) string {
		if strings.TrimSpace(trigger.Source) == agentlink.Channel {
			return ""
		}
		return channel
	}
}

// CountRunningTasks counts reader's running tasks under the entries `entry` names, with every
// entry in `entries` present (zero when none runs). ok is false when reader cannot count, or its
// count failed: the counts are unknown then.
func CountRunningTasks(reader TaskReader, entry func(TaskTrigger) string, entries ...string) (map[string]int, bool) {
	counter, ok := reader.(RunningTaskCounter)
	if !ok || counter == nil || entry == nil {
		return nil, false
	}
	counts, err := counter.CountRunningTasks(entry)
	if err != nil {
		return nil, false
	}
	out := make(map[string]int, len(counts)+len(entries))
	for _, name := range entries {
		out[name] = 0
	}
	for name, n := range counts {
		out[name] += n
	}
	return out, true
}

func countRunningTasks(items map[string]TaskInfo, triggers map[string]TaskTrigger, entry func(TaskTrigger) string) map[string]int {
	counts := map[string]int{}
	for id, item := range items {
		if !IsRunningExecution(item) {
			continue
		}
		if name := entry(triggers[id]); name != "" {
			counts[name]++
		}
	}
	return counts
}

// CountRunningTasks counts the store's running tasks (RunningTaskCounter).
func (s *FileTaskStore) CountRunningTasks(entry func(TaskTrigger) string) (map[string]int, error) {
	if s == nil || entry == nil {
		return map[string]int{}, nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return countRunningTasks(s.items, s.triggers, entry), nil
}

// CountRunningTasks counts the store's running tasks (RunningTaskCounter), after taking in what
// the chat command's processes wrote to the shared store and ending the tasks of those gone.
func (s *ConsoleFileStore) CountRunningTasks(entry func(TaskTrigger) string) (map[string]int, error) {
	if s == nil || entry == nil {
		return map[string]int{}, nil
	}
	unlock, err := s.lockShared()
	if err != nil {
		return nil, err
	}
	defer unlock()
	return countRunningTasks(s.items, s.triggers, entry), nil
}

// channelRunningTasks is a channel runtime's own `running_tasks`, from its task store; nil when
// mode is not a messaging channel or the store cannot count.
func channelRunningTasks(mode string, reader TaskReader) map[string]any {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if !messagingChannelModes[mode] || reader == nil {
		return nil
	}
	counts, ok := CountRunningTasks(reader, ChannelRunningTaskEntry(mode), mode)
	if !ok {
		return nil
	}
	return map[string]any{mode: counts[mode]}
}
