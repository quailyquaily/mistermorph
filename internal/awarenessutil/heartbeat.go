package awarenessutil

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/personastore"
)

const awarenessFailureThreshold = 3

type Behavior string

const (
	BehaviorHeartbeat Behavior = "heartbeat"
	BehaviorPoke      Behavior = "poke"
	BehaviorCron      Behavior = "cron"
)

var ErrEmptyPokeBody = errors.New("poke body text is required")

func NormalizeBehavior(raw string) Behavior {
	switch Behavior(strings.ToLower(strings.TrimSpace(raw))) {
	case BehaviorPoke:
		return BehaviorPoke
	case BehaviorCron:
		return BehaviorCron
	default:
		return BehaviorHeartbeat
	}
}

func BuildAwarenessTask(behavior Behavior, checklistPath string, input awarenessdomain.PokeInput) (string, bool, error) {
	switch NormalizeBehavior(string(behavior)) {
	case BehaviorPoke:
		return BuildPokeTask(input)
	default:
		return BuildHeartbeatTask(checklistPath)
	}
}

func BuildHeartbeatTask(checklistPath string) (string, bool, error) {
	return readHeartbeatChecklist(checklistPath)
}

func BuildPokeTask(input awarenessdomain.PokeInput) (string, bool, error) {
	input = input.Normalize()
	if !input.HasBody || input.BodyText == "" {
		return "", true, ErrEmptyPokeBody
	}
	return input.BodyText, false, nil
}

func BuildAwarenessMeta(behavior Behavior, source string, interval time.Duration, checklistPath string, taskEmpty bool, input awarenessdomain.PokeInput, extra map[string]any) map[string]any {
	behavior = NormalizeBehavior(string(behavior))
	awareness := map[string]any{
		"behavior":         string(behavior),
		"source":           source,
		"scheduled_at_utc": time.Now().UTC().Format(time.RFC3339),
	}
	if behavior == BehaviorHeartbeat && interval > 0 {
		awareness["interval"] = interval.String()
	}
	// No checklist_path: the heartbeat task is in agent.db's heartbeat_workflows now, and a path
	// to HEARTBEAT.md would send the agent to read a file that is no longer there.
	if taskEmpty {
		awareness["task_empty"] = true
	}
	if pokeMeta := input.MetaValue(); pokeMeta != nil {
		awareness["poke"] = pokeMeta
	}
	for k, v := range extra {
		if strings.TrimSpace(k) == "" {
			continue
		}
		awareness[k] = v
	}
	out := map[string]any{
		"trigger":   string(behavior),
		"awareness": awareness,
	}
	if behavior == BehaviorHeartbeat {
		out["heartbeat"] = awareness
	}
	return out
}

func BuildCronMeta(source string, taskID string, scheduledAtUTC time.Time, schedule string, tz string, chatID string, extra map[string]any) map[string]any {
	awareness := map[string]any{
		"behavior": string(BehaviorCron),
		"source":   strings.TrimSpace(source),
		"task_id":  strings.TrimSpace(taskID),
	}
	if scheduledAtUTC.IsZero() {
		scheduledAtUTC = time.Now().UTC()
	}
	awareness["scheduled_at_utc"] = scheduledAtUTC.UTC().Format(time.RFC3339)
	if strings.TrimSpace(schedule) != "" {
		awareness["schedule"] = strings.TrimSpace(schedule)
	}
	if strings.TrimSpace(tz) != "" {
		awareness["tz"] = strings.TrimSpace(tz)
	}
	if strings.TrimSpace(chatID) != "" {
		awareness["chat_id"] = strings.TrimSpace(chatID)
	}
	for k, v := range extra {
		if strings.TrimSpace(k) == "" {
			continue
		}
		awareness[k] = v
	}
	return map[string]any{
		"trigger":   string(BehaviorCron),
		"awareness": awareness,
	}
}

type State struct {
	mu          sync.Mutex
	running     bool
	failures    int
	lastSuccess time.Time
	lastError   string
}

func (s *State) Start() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

func (s *State) EndSkipped() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

func (s *State) EndSuccess(now time.Time) {
	s.mu.Lock()
	s.running = false
	s.failures = 0
	s.lastError = ""
	s.lastSuccess = now
	s.mu.Unlock()
}

func (s *State) EndFailure(err error) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	s.failures++
	if err != nil {
		s.lastError = strings.TrimSpace(err.Error())
	}
	if s.failures >= awarenessFailureThreshold {
		msg := "awareness_failed"
		if s.lastError != "" {
			msg = fmt.Sprintf("awareness_failed (%s)", s.lastError)
		}
		s.failures = 0
		return true, "ALERT: " + msg
	}
	return false, ""
}

// readHeartbeatChecklist renders the heartbeat task from the enabled workflows in agent.db, in the
// state folder checklistPath (its HEARTBEAT.md, which the workflows were) is in. With none
// enabled there is no task.
func readHeartbeatChecklist(checklistPath string) (string, bool, error) {
	checklistPath = strings.TrimSpace(checklistPath)
	if checklistPath == "" {
		return "", true, nil
	}
	ctx := context.Background()
	store, err := personastore.ForStateDir(ctx, filepath.Dir(checklistPath))
	if err != nil {
		return "", true, err
	}
	return store.HeartbeatTask(ctx)
}
