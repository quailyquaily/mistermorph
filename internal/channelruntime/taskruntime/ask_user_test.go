package taskruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestParseUserQuestion(t *testing.T) {
	tests := []struct {
		name    string
		params  map[string]any
		want    UserQuestion
		wantErr string
	}{
		{
			name:   "open question",
			params: map[string]any{"question": "  Which folder?  "},
			want:   UserQuestion{Text: "Which folder?"},
		},
		{
			name: "options as objects and strings",
			params: map[string]any{"question": "Which account?", "options": []any{
				map[string]any{"label": " Personal ", "description": " lyric@example.com "},
				"Company",
			}},
			want: UserQuestion{Text: "Which account?", Options: []UserQuestionOption{
				{Label: "Personal", Description: "lyric@example.com"},
				{Label: "Company"},
			}},
		},
		{name: "missing question", params: map[string]any{"question": " "}, wantErr: "question is required"},
		{name: "one option", params: map[string]any{"question": "Q", "options": []any{"A"}}, wantErr: "2 to 4"},
		{name: "five options", params: map[string]any{"question": "Q", "options": []any{"A", "B", "C", "D", "E"}}, wantErr: "2 to 4"},
		{name: "empty label", params: map[string]any{"question": "Q", "options": []any{"A", map[string]any{"description": "x"}}}, wantErr: "needs a label"},
		{name: "repeated label", params: map[string]any{"question": "Q", "options": []any{"Yes", "yes"}}, wantErr: "repeated"},
		{name: "long label", params: map[string]any{"question": "Q", "options": []any{"A", strings.Repeat("b", 61)}}, wantErr: "too long"},
		{name: "long question", params: map[string]any{"question": strings.Repeat("q", 1501)}, wantErr: "too long"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseUserQuestion(tt.params)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("parseUserQuestion() error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseUserQuestion() error = %v", err)
			}
			if got.Text != tt.want.Text || len(got.Options) != len(tt.want.Options) {
				t.Fatalf("parseUserQuestion() = %#v, want %#v", got, tt.want)
			}
			for i := range got.Options {
				if got.Options[i] != tt.want.Options[i] {
					t.Fatalf("option %d = %#v, want %#v", i, got.Options[i], tt.want.Options[i])
				}
			}
		})
	}
}

func TestAskUserToolExecute(t *testing.T) {
	params := map[string]any{"question": "Which?", "options": []any{"A", "B"}}
	tests := []struct {
		name    string
		ctx     func() (context.Context, context.CancelFunc)
		ask     AskUserFunc
		want    string
		wantErr bool
		noAsk   bool
	}{
		{
			name: "chosen",
			ask: func(context.Context, UserQuestion) (runtimecontrol.Answer, error) {
				return runtimecontrol.Answer{Text: "B", Option: 1}, nil
			},
			want: "The user chose: B",
		},
		{
			name: "typed",
			ask: func(context.Context, UserQuestion) (runtimecontrol.Answer, error) {
				return runtimecontrol.Answer{Text: "neither", Option: -1}, nil
			},
			want: "The user answered: neither",
		},
		{
			name: "no answer in time",
			ask: func(context.Context, UserQuestion) (runtimecontrol.Answer, error) {
				return runtimecontrol.Answer{}, context.DeadlineExceeded
			},
			want: "did not answer within 10 minutes",
		},
		{
			name: "task stopped",
			ctx: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx, func() {}
			},
			ask: func(ctx context.Context, _ UserQuestion) (runtimecontrol.Answer, error) {
				return runtimecontrol.Answer{}, ctx.Err()
			},
			wantErr: true,
		},
		{
			name: "send failed",
			ask: func(context.Context, UserQuestion) (runtimecontrol.Answer, error) {
				return runtimecontrol.Answer{}, errors.New("telegram is down")
			},
			wantErr: true,
		},
		{
			name: "too little time left",
			ctx: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 2*time.Minute)
			},
			want:  "too little time left",
			noAsk: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.Background(), context.CancelFunc(func() {})
			if tt.ctx != nil {
				ctx, cancel = tt.ctx()
			}
			defer cancel()
			asked := false
			tool := newAskUserTool(func(ctx context.Context, q UserQuestion) (runtimecontrol.Answer, error) {
				asked = true
				if q.ID == "" || q.Text != "Which?" || len(q.Options) != 2 {
					t.Errorf("ask got %#v", q)
				}
				if tt.ask == nil {
					return runtimecontrol.Answer{}, errors.New("unexpected ask")
				}
				return tt.ask(ctx, q)
			})
			got, err := tool.Execute(ctx, params)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("Execute() = %q, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			if !strings.Contains(got, tt.want) {
				t.Fatalf("Execute() = %q, want %q", got, tt.want)
			}
			if asked == tt.noAsk {
				t.Fatalf("asked = %v, want %v", asked, !tt.noAsk)
			}
		})
	}
}

func TestLeaseUserQuestionsSettlesWithTheAnswer(t *testing.T) {
	control := runtimecontrol.New()
	lease, err := control.StartLease(context.Background(), 0, runtimecontrol.ActiveRun{
		Runtime:         "slack",
		ConversationKey: "slack:T:D",
		TaskID:          "task_1",
	})
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	defer lease.Finish()

	var (
		mu      sync.Mutex
		settled []string
	)
	shown := make(chan UserQuestion, 2)
	ask := LeaseUserQuestions(lease, nil, func(_ context.Context, q UserQuestion) (func(context.Context, *runtimecontrol.Answer), error) {
		shown <- q
		return func(_ context.Context, answer *runtimecontrol.Answer) {
			mu.Lock()
			settled = append(settled, UserQuestionAnswerLabel(answer))
			mu.Unlock()
		}, nil
	})

	done := make(chan runtimecontrol.Answer, 1)
	go func() {
		answer, _ := ask(context.Background(), UserQuestion{ID: "q1", Text: "Which?", Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}}})
		done <- answer
	}()
	q := <-shown
	// The question is open once it is shown.
	if _, ok := control.Choose("slack", q.ID, 0); !ok {
		t.Fatal("Choose() right after the question was shown = false")
	}
	if answer := <-done; answer.Text != "A" {
		t.Fatalf("answer = %#v, want A", answer)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := ask(ctx, UserQuestion{ID: "q2", Text: "Again?"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ask() error = %v, want DeadlineExceeded", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(settled) != 2 || settled[0] != "Answer: A" || settled[1] != "No answer." {
		t.Fatalf("settled = %#v", settled)
	}
}
