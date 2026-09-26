package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

type resumeState struct {
	Version int `json:"v"`

	RunID string `json:"run_id"`
	Model string `json:"model"`
	Scene string `json:"scene,omitempty"`
	Step  int    `json:"step"`

	PlanRequired  bool `json:"plan_required"`
	ParseFailures int  `json:"parse_failures"`

	Messages    []llm.Message   `json:"messages"`
	ExtraParams map[string]any  `json:"extra_params,omitempty"`
	AgentCtx    contextSnapshot `json:"agent_ctx"`

	MetaMessageIndex        *int              `json:"meta_message_index,omitempty"`
	FixedMessageCount       int               `json:"fixed_message_count,omitempty"`
	MessageBoundaries       map[int]string    `json:"message_boundaries,omitempty"`
	Checkpoint              ContextCheckpoint `json:"checkpoint,omitempty"`
	HasCheckpoint           bool              `json:"has_checkpoint,omitempty"`
	ContextWindowTokens     int64             `json:"context_window_tokens,omitempty"`
	ProtectedMessageIndexes map[int]struct{}  `json:"protected_message_indexes,omitempty"`
	LastMainInputTokens     int               `json:"last_main_input_tokens,omitempty"`
	LastMainMessageCount    int               `json:"last_main_message_count,omitempty"`
	HasLastMainInputTokens  bool              `json:"has_last_main_input_tokens,omitempty"`

	PendingTool pendingToolSnapshot `json:"pending_tool"`
}

type pendingToolSnapshot struct {
	AssistantText      string     `json:"assistant_text"`
	AssistantTextAdded bool       `json:"assistant_text_added,omitempty"`
	ApprovalIdentity   string     `json:"approval_identity,omitempty"`
	ToolCall           ToolCall   `json:"tool_call"`
	RemainingToolCalls []ToolCall `json:"remaining_tool_calls,omitempty"`
}

type contextSnapshot struct {
	Task     string         `json:"task"`
	MaxSteps int            `json:"max_steps"`
	Plan     *Plan          `json:"plan,omitempty"`
	Metrics  *Metrics       `json:"metrics,omitempty"`
	Steps    []stepSnapshot `json:"steps,omitempty"`
}

type stepSnapshot struct {
	StepNumber  int            `json:"step"`
	Thought     string         `json:"thought,omitempty"`
	Action      string         `json:"action,omitempty"`
	ActionInput map[string]any `json:"action_input,omitempty"`
	Observation string         `json:"observation,omitempty"`
	Error       string         `json:"error,omitempty"`
	DurationMs  int64          `json:"duration_ms,omitempty"`
}

func snapshotFromContext(c *Context) contextSnapshot {
	if c == nil {
		return contextSnapshot{}
	}
	out := contextSnapshot{
		Task:     c.Task,
		MaxSteps: c.MaxSteps,
		Plan:     c.Plan,
		Metrics:  c.Metrics,
	}
	if len(c.Steps) == 0 {
		return out
	}
	steps := make([]stepSnapshot, 0, len(c.Steps))
	for _, s := range c.Steps {
		var errStr string
		if s.Error != nil {
			errStr = s.Error.Error()
		}
		steps = append(steps, stepSnapshot{
			StepNumber:  s.StepNumber,
			Thought:     s.Thought,
			Action:      s.Action,
			ActionInput: s.ActionInput,
			Observation: s.Observation,
			Error:       errStr,
			DurationMs:  s.Duration.Milliseconds(),
		})
	}
	out.Steps = steps
	return out
}

func contextFromSnapshot(s contextSnapshot) *Context {
	c := NewContext(s.Task, s.MaxSteps)
	c.Plan = s.Plan
	if s.Metrics != nil {
		c.Metrics = s.Metrics
	}
	for _, ss := range s.Steps {
		var err error
		if ss.Error != "" {
			err = errors.New(ss.Error)
		}
		c.Steps = append(c.Steps, Step{
			StepNumber:  ss.StepNumber,
			Thought:     ss.Thought,
			Action:      ss.Action,
			ActionInput: ss.ActionInput,
			Observation: ss.Observation,
			Error:       err,
			Duration:    time.Duration(ss.DurationMs) * time.Millisecond,
		})
	}
	return c
}

func marshalResumeState(st resumeState) ([]byte, error) {
	st.Version = 2
	return json.Marshal(st)
}

func unmarshalResumeState(b []byte) (resumeState, error) {
	var st resumeState
	if err := json.Unmarshal(b, &st); err != nil {
		return resumeState{}, err
	}
	if st.Version < 0 || st.Version > 2 {
		return resumeState{}, fmt.Errorf("unsupported resume_state version: %d", st.Version)
	}
	if st.Version < 2 {
		st.MetaMessageIndex = nil
	} else {
		if st.FixedMessageCount < 0 || st.FixedMessageCount > len(st.Messages) {
			return resumeState{}, fmt.Errorf("invalid fixed message count")
		}
		if err := validateMetaMessageIndex(st.Messages, st.FixedMessageCount, st.MetaMessageIndex); err != nil {
			return resumeState{}, err
		}
		for index := range st.MessageBoundaries {
			if index < 0 || index >= len(st.Messages) {
				return resumeState{}, fmt.Errorf("invalid history boundary index %d", index)
			}
		}
		for index := range st.ProtectedMessageIndexes {
			if index < 0 || index >= len(st.Messages) {
				return resumeState{}, fmt.Errorf("invalid protected message index %d", index)
			}
		}
	}
	return st, nil
}

func validateMetaMessageIndex(messages []llm.Message, fixed int, index *int) error {
	if index == nil {
		return nil
	}
	if *index < fixed || *index >= len(messages) || *index < 1 {
		return fmt.Errorf("invalid runtime metadata index %d", *index)
	}
	m := messages[*index]
	if m.Role != "user" || m.Content == "" || len(m.Parts) != 0 || len(m.ToolCalls) != 0 || m.ToolCallID != "" {
		return fmt.Errorf("invalid runtime metadata message at %d", *index)
	}
	return nil
}
