package runtimecontrol

import (
	"context"
	"errors"
	"testing"
	"time"
)

func startQuestionLease(t *testing.T, control *RunControl) *RunLease {
	t.Helper()
	lease, err := control.StartLease(context.Background(), 0, ActiveRun{
		Runtime:         "telegram",
		ConversationKey: "tg:1",
		TaskID:          "task_1",
		RunID:           "run_1",
	})
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	t.Cleanup(func() { lease.Finish() })
	return lease
}

func TestChoicesOnlyQuestionKeepsSteeringSeparate(t *testing.T) {
	control := New()
	lease := startQuestionLease(t, control)
	question, err := lease.OpenQuestion("permission", []string{"Allow once", "Deny"}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer question.Close()
	if control.AnswerText("telegram", "permission", "yes") {
		t.Fatal("text answered a choice-only question")
	}
	result := control.Steer("telegram", "tg:1", "also check the docs")
	if !result.Queued || result.Answered {
		t.Fatalf("steer=%+v", result)
	}
	if _, ok := control.Choose("telegram", "permission", 1); !ok {
		t.Fatal("choice was not accepted")
	}
	answer, err := question.Wait(context.Background())
	if err != nil || answer.Option != 1 {
		t.Fatalf("answer=%+v err=%v", answer, err)
	}
	if _, ok := control.Choose("telegram", "permission", 0); ok {
		t.Fatal("stale answer was accepted")
	}
}

// awaitOpen waits until the lease's run has question id open, so an answer cannot race the wait.
func awaitOpen(t *testing.T, control *RunControl, id string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		control.mu.Lock()
		open := false
		for _, entry := range control.active {
			if entry.question != nil && entry.question.id == id {
				open = true
			}
		}
		control.mu.Unlock()
		if open {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("question %q never opened", id)
}

func TestRunLeaseAwaitAnswer(t *testing.T) {
	type result struct {
		answer Answer
		err    error
	}
	tests := []struct {
		name   string
		answer func(control *RunControl) bool
		want   Answer
	}{
		{
			name: "button",
			answer: func(control *RunControl) bool {
				label, ok := control.Choose("telegram", "q1", 1)
				return ok && label == "Company"
			},
			want: Answer{Text: "Company", Option: 1},
		},
		{
			name: "typed in the question",
			answer: func(control *RunControl) bool {
				return !control.AnswerText("telegram", "q1", "  ") && control.AnswerText("telegram", "q1", " neither ")
			},
			want: Answer{Text: "neither", Option: -1},
		},
		{
			name: "typed message",
			answer: func(control *RunControl) bool {
				got := control.Steer("telegram", "tg:1", "  the second one  ")
				return got.Found && got.Queued && got.Answered && got.TaskID == "task_1"
			},
			want: Answer{Text: "the second one", Option: -1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			control := New()
			lease := startQuestionLease(t, control)
			done := make(chan result, 1)
			go func() {
				answer, err := lease.AwaitAnswer(context.Background(), "q1", []string{"Personal", "Company"})
				done <- result{answer, err}
			}()
			awaitOpen(t, control, "q1")
			if !tt.answer(control) {
				t.Fatal("answer was not taken")
			}
			got := <-done
			if got.err != nil || got.answer != tt.want {
				t.Fatalf("AwaitAnswer() = %#v, %v; want %#v", got.answer, got.err, tt.want)
			}
			if len(lease.SteerQueue.Drain()) != 0 {
				t.Fatal("the answer was also queued as a steer")
			}
			// The question is closed: the next message steers the run again.
			if next := control.Steer("telegram", "tg:1", "and hurry"); !next.Queued || next.Answered {
				t.Fatalf("Steer() after answer = %#v, want queued steer", next)
			}
		})
	}
}

func TestRunControlChooseIgnoresStaleOrWrongQuestion(t *testing.T) {
	control := New()
	lease := startQuestionLease(t, control)
	if _, ok := control.Choose("telegram", "q1", 0); ok {
		t.Fatal("Choose() with no open question = true")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := lease.AwaitAnswer(ctx, "q2", []string{"Yes", "No"})
		done <- err
	}()
	awaitOpen(t, control, "q2")
	for _, tt := range []struct {
		name    string
		runtime string
		id      string
		option  int
	}{
		{"another question", "telegram", "q1", 0},
		{"another runtime", "slack", "q2", 0},
		{"no such choice", "telegram", "q2", 2},
		{"negative choice", "telegram", "q2", -1},
	} {
		if _, ok := control.Choose(tt.runtime, tt.id, tt.option); ok {
			t.Fatalf("Choose() for %s = true", tt.name)
		}
	}
	if _, err := lease.AwaitAnswer(context.Background(), "q3", nil); !errors.Is(err, ErrQuestionAlreadyOpen) {
		t.Fatalf("second AwaitAnswer() error = %v, want ErrQuestionAlreadyOpen", err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("AwaitAnswer() after cancel error = %v, want context.Canceled", err)
	}
	if _, ok := control.Choose("telegram", "q2", 0); ok {
		t.Fatal("Choose() after the wait ended = true")
	}
}

func TestRunLeaseAwaitAnswerEndsWhenStopped(t *testing.T) {
	control := New()
	lease := startQuestionLease(t, control)
	done := make(chan error, 1)
	go func() {
		_, err := lease.AwaitAnswer(lease.Context, "q1", nil)
		done <- err
	}()
	awaitOpen(t, control, "q1")
	if got := control.Stop("telegram", "tg:1", "/stop"); !got.Found {
		t.Fatal("Stop() found no run")
	}
	if err := <-done; err == nil {
		t.Fatal("AwaitAnswer() after stop error = nil")
	}
	if !lease.UserStopped() {
		t.Fatal("UserStopped() = false")
	}
}
