package taskruntime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	AskUserToolName = "ask_user"
	// UserQuestionTimeout is how long ask_user waits for an answer.
	UserQuestionTimeout = 10 * time.Minute
	// The run keeps this much of its deadline to go on after a question that got no answer.
	userQuestionDeadlineMargin = 2 * time.Minute
	userQuestionMinWait        = time.Minute
	userQuestionSettleTimeout  = 10 * time.Second

	userQuestionMaxOptions     = 4
	userQuestionMaxLabelRunes  = 60
	userQuestionMaxDetailRunes = 200
	userQuestionMaxTextRunes   = 1500
)

// UserQuestionOption is one choice of a question.
type UserQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// UserQuestion is a question ask_user puts to the person. ID is short and URL-safe, for button data.
type UserQuestion struct {
	ChoicesOnly bool                 `json:"choices_only,omitempty"`
	ID          string               `json:"id"`
	Text        string               `json:"text"`
	Options     []UserQuestionOption `json:"options,omitempty"`
}

// AskUserFunc puts q to the person a task came from and waits for the answer until ctx ends.
type AskUserFunc func(ctx context.Context, q UserQuestion) (runtimecontrol.Answer, error)

// ShowUserQuestionFunc sends q to the person. The settle func it returns updates what was sent once
// the question closes: to the answer, or to "no answer" when answer is nil.
type ShowUserQuestionFunc func(ctx context.Context, q UserQuestion) (settle func(ctx context.Context, answer *runtimecontrol.Answer), err error)

type userQuestionsContextKey struct{}

// WithUserQuestions gives the task's run the ask_user tool, which puts questions to the person
// through ask. Use it only where one person can answer, with buttons for the choices.
func WithUserQuestions(ctx context.Context, ask AskUserFunc) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if ask == nil {
		return ctx
	}
	return context.WithValue(ctx, userQuestionsContextKey{}, ask)
}

func userQuestionsFromContext(ctx context.Context) AskUserFunc {
	if ctx == nil {
		return nil
	}
	ask, _ := ctx.Value(userQuestionsContextKey{}).(AskUserFunc)
	return ask
}

// LeaseUserQuestions is the AskUserFunc of a runtime whose runs hold a run control lease: show
// sends the question, the lease takes the answer (a typed message, or a button through
// RunControl.Choose or AnswerText), and the settle func show returned updates the question.
func LeaseUserQuestions(lease *runtimecontrol.RunLease, logger *slog.Logger, show ShowUserQuestionFunc) AskUserFunc {
	if lease == nil || show == nil {
		return nil
	}
	if logger == nil {
		logger = slog.Default()
	}
	return func(ctx context.Context, q UserQuestion) (runtimecontrol.Answer, error) {
		labels := make([]string, 0, len(q.Options))
		for _, option := range q.Options {
			labels = append(labels, option.Label)
		}
		// Open before showing, so an answer that comes at once is not lost.
		open, err := lease.OpenQuestion(q.ID, labels, q.ChoicesOnly)
		if err != nil {
			return runtimecontrol.Answer{}, err
		}
		defer open.Close()
		settle, err := show(ctx, q)
		if err != nil {
			return runtimecontrol.Answer{}, err
		}
		answer, waitErr := open.Wait(ctx)
		open.Close()
		if settle != nil {
			settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), userQuestionSettleTimeout)
			if waitErr != nil {
				settle(settleCtx, nil)
			} else {
				settle(settleCtx, &answer)
			}
			cancel()
		}
		if waitErr != nil {
			logger.Info("user_question_unanswered", "question_id", q.ID, "error", waitErr.Error())
		}
		return answer, waitErr
	}
}

// UserQuestionAnswerLabel is how a closed question shows its answer, or that it got none.
func UserQuestionAnswerLabel(answer *runtimecontrol.Answer) string {
	if answer == nil {
		return "No answer."
	}
	return "Answer: " + answer.Text
}

type askUserTool struct {
	ask AskUserFunc
}

func newAskUserTool(ask AskUserFunc) *askUserTool {
	return &askUserTool{ask: ask}
}

func (t *askUserTool) Name() string { return AskUserToolName }

func (t *askUserTool) Description() string {
	return "Ask the user a question and wait for the answer. Use it only for a decision or fact you cannot find or reasonably decide yourself, such as a choice between real alternatives or the meaning of an unclear request; do not ask for permission to do what the user already asked. " +
		"When the answer is one of a few, give 2 to 4 short, distinct options; the user can always type their own answer instead. Ask one question at a time. " +
		fmt.Sprintf("If no answer comes within %d minutes, decide yourself and say what you assumed.", int(UserQuestionTimeout/time.Minute))
}

func (t *askUserTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"question": map[string]any{
				"type":        "string",
				"description": "The question, complete and self-contained, in the user's language.",
			},
			"options": map[string]any{
				"type":        "array",
				"description": "2 to 4 choices, when the answer is one of a few. Omit for an open question.",
				"minItems":    2,
				"maxItems":    userQuestionMaxOptions,
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"properties": map[string]any{
						"label": map[string]any{
							"type":        "string",
							"description": fmt.Sprintf("The choice, a few words (at most %d characters).", userQuestionMaxLabelRunes),
						},
						"description": map[string]any{
							"type":        "string",
							"description": "What the choice means, when the label alone is not clear.",
						},
					},
					"required": []string{"label"},
				},
			},
		},
		"required": []string{"question"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

// CodeModeExcluded keeps ask_user out of codemode scripts: the user should see the question as the
// tool's own call.
func (t *askUserTool) CodeModeExcluded() bool { return true }

func (t *askUserTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.ask == nil {
		return "", fmt.Errorf("ask_user is unavailable here")
	}
	q, err := parseUserQuestion(params)
	if err != nil {
		return "", err
	}
	wait := UserQuestionTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if left := time.Until(deadline) - userQuestionDeadlineMargin; left < wait {
			wait = left
		}
	}
	if wait < userQuestionMinWait {
		return "The task has too little time left to wait for an answer. Decide yourself, and say what you assumed.", nil
	}
	q.ID = newUserQuestionID()
	waitCtx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	answer, err := t.ask(waitCtx, q)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Sprintf("The user did not answer within %d minutes. Decide yourself, and say what you assumed.", int(wait.Round(time.Minute)/time.Minute)), nil
		}
		return "", fmt.Errorf("could not ask the user: %w", err)
	}
	if answer.Typed() {
		return "The user answered: " + answer.Text, nil
	}
	return "The user chose: " + answer.Text, nil
}

func parseUserQuestion(params map[string]any) (UserQuestion, error) {
	text, _ := params["question"].(string)
	text = strings.TrimSpace(text)
	if text == "" {
		return UserQuestion{}, fmt.Errorf("question is required")
	}
	if utf8.RuneCountInString(text) > userQuestionMaxTextRunes {
		return UserQuestion{}, fmt.Errorf("question is too long (at most %d characters)", userQuestionMaxTextRunes)
	}
	q := UserQuestion{Text: text}
	raw, _ := params["options"].([]any)
	if len(raw) == 0 {
		return q, nil
	}
	if len(raw) < 2 || len(raw) > userQuestionMaxOptions {
		return UserQuestion{}, fmt.Errorf("options needs 2 to %d choices, or none", userQuestionMaxOptions)
	}
	seen := map[string]bool{}
	for _, item := range raw {
		var option UserQuestionOption
		switch value := item.(type) {
		case string:
			option.Label = value
		case map[string]any:
			option.Label, _ = value["label"].(string)
			option.Description, _ = value["description"].(string)
		}
		option.Label = strings.TrimSpace(option.Label)
		option.Description = strings.TrimSpace(option.Description)
		if option.Label == "" {
			return UserQuestion{}, fmt.Errorf("every option needs a label")
		}
		if utf8.RuneCountInString(option.Label) > userQuestionMaxLabelRunes {
			return UserQuestion{}, fmt.Errorf("option label %q is too long (at most %d characters); move detail to its description", option.Label, userQuestionMaxLabelRunes)
		}
		if utf8.RuneCountInString(option.Description) > userQuestionMaxDetailRunes {
			return UserQuestion{}, fmt.Errorf("option description is too long (at most %d characters)", userQuestionMaxDetailRunes)
		}
		folded := strings.ToLower(option.Label)
		if seen[folded] {
			return UserQuestion{}, fmt.Errorf("option label %q is repeated", option.Label)
		}
		seen[folded] = true
		q.Options = append(q.Options, option)
	}
	return q, nil
}

func newUserQuestionID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

var _ tools.CodeModeExcluded = (*askUserTool)(nil)
