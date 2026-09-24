package llm

import (
	"context"
	"errors"
	"time"
)

// Evaluator is optional: Chat-only clients need not implement judgments.
type Evaluator interface {
	Evaluate(context.Context, EvaluateRequest) (*EvaluateResult, error)
}

// Evaluate checks optional capability at wrapper boundaries without unwrapping
// clients (which would bypass accounting, routing, and request inspection).
func Evaluate(ctx context.Context, client Client, req EvaluateRequest) (*EvaluateResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	evaluator, ok := client.(Evaluator)
	if !ok {
		return nil, ErrEvaluateUnsupported
	}
	return evaluator.Evaluate(ctx, req)
}

var (
	ErrEvaluateUnsupported     = errors.New("evaluate unsupported")
	ErrEvaluateInvalidRequest  = errors.New("invalid evaluate request")
	ErrEvaluateInvalidResponse = errors.New("invalid evaluate response")
)

type QuestionKind string

const (
	Boolean QuestionKind = "boolean"
	Choice  QuestionKind = "choice"
	Score   QuestionKind = "score"
)

type Question struct {
	Kind         QuestionKind   `json:"kind"`
	Instructions string         `json:"instructions"`
	Options      map[string]any `json:"options,omitempty"`
	Levels       []any          `json:"levels,omitempty"`
}

type Answer struct {
	Kind            QuestionKind `json:"kind"`
	BooleanValue    *bool        `json:"boolean_value,omitempty"`
	ProbabilityTrue *float64     `json:"probability_true,omitempty"`
	Selected        string       `json:"selected,omitempty"`
	ScoreValue      *float64     `json:"score_value,omitempty"`
}

type EvaluateRequest struct {
	Model     string               `json:"model,omitempty"`
	Scene     string               `json:"scene,omitempty"`
	State     any                  `json:"state"`
	Questions map[string]Question  `json:"questions"`
	DebugFn   func(string, string) `json:"-"`
}

type EvaluateUsage struct {
	InputTokens  *int `json:"input_tokens,omitempty"`
	OutputTokens *int `json:"output_tokens,omitempty"`
	TotalTokens  *int `json:"total_tokens,omitempty"`
	// Details preserves the existing accounting format, including cache and cost.
	Details Usage `json:"details"`
}

type EvaluateResult struct {
	Provider string            `json:"provider"`
	Model    string            `json:"model"`
	Emulated bool              `json:"emulated"`
	Answers  map[string]Answer `json:"answers"`
	Usage    *EvaluateUsage    `json:"usage,omitempty"`
	Duration time.Duration     `json:"duration"`
}
