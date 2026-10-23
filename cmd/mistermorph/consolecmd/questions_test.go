package consolecmd

import (
	"context"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestConsoleAsksUser(t *testing.T) {
	tests := []struct {
		name    string
		trigger daemonruntime.TaskTrigger
		want    bool
	}{
		{"chat", daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: consoleChatTriggerRef}, true},
		{"default ui trigger", daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "web/console"}, false},
		{"awareness", daemonruntime.TaskTrigger{Source: "console", Event: "awareness_heartbeat"}, false},
		{"agent link", daemonruntime.TaskTrigger{Source: "agentlink", Event: "reply", Ref: consoleChatTriggerRef}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consoleAsksUser(tt.trigger); got != tt.want {
				t.Fatalf("consoleAsksUser() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestConsoleTaskQuestionsPublishAndSettle(t *testing.T) {
	hub := newConsoleStreamHub()
	frames, unsubscribe := hub.Subscribe("task_1")
	defer unsubscribe()
	questions := &consoleTaskQuestions{taskID: "task_1", hub: hub}
	settle, err := questions.show(context.Background(), taskruntime.UserQuestion{
		ID:      "q1",
		Text:    "Which?",
		Options: []taskruntime.UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatalf("show() error = %v", err)
	}
	if frame := <-frames; len(frame.Questions) != 1 || frame.Questions[0].Status != consoleQuestionOpen {
		t.Fatalf("open frame = %#v", frame.Questions)
	}
	settle(context.Background(), &runtimecontrol.Answer{Text: "B", Option: 1})
	frame := <-frames
	if len(frame.Questions) != 1 || frame.Questions[0].Status != consoleQuestionAnswered || frame.Questions[0].Answer != "B" || *frame.Questions[0].Option != 1 {
		t.Fatalf("answered frame = %#v", frame.Questions)
	}

	settleTyped, _ := questions.show(context.Background(), taskruntime.UserQuestion{ID: "q2", Text: "Why?"})
	<-frames
	settleTyped(context.Background(), &runtimecontrol.Answer{Text: "because", Option: -1})
	<-frames
	settleNone, _ := questions.show(context.Background(), taskruntime.UserQuestion{ID: "q3", Text: "Now?"})
	<-frames
	settleNone(context.Background(), nil)
	<-frames

	got := questions.snapshot()
	if len(got) != 3 || *got[1].Option != -1 || got[1].Answer != "because" || got[2].Status != consoleQuestionExpired || got[2].Option != nil {
		t.Fatalf("snapshot = %#v", got)
	}
}

func TestConsoleAnswerQuestion(t *testing.T) {
	r := &consoleLocalRuntime{consoleExecutionState: &consoleExecutionState{runControl: runtimecontrol.New()}}
	lease, err := r.runControl.StartLease(context.Background(), 0, runtimecontrol.ActiveRun{
		Runtime:         "console",
		ConversationKey: "console:topic",
		TaskID:          "task_1",
	})
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	defer lease.Finish()

	if _, err := r.answerQuestion(context.Background(), daemonruntime.AnswerQuestionRequest{TaskID: "task_1"}); err == nil {
		t.Fatal("answerQuestion() without question_id error = nil")
	}
	ask := func(options []string) <-chan runtimecontrol.Answer {
		done := make(chan runtimecontrol.Answer, 1)
		go func() {
			answer, _ := lease.AwaitAnswer(context.Background(), "q1", options)
			done <- answer
		}()
		return done
	}
	answerUntilTaken := func(req daemonruntime.AnswerQuestionRequest) daemonruntime.AnswerQuestionResponse {
		deadline := time.Now().Add(2 * time.Second)
		for {
			resp, err := r.answerQuestion(context.Background(), req)
			if err != nil {
				t.Fatalf("answerQuestion() error = %v", err)
			}
			if resp.Answered || time.Now().After(deadline) {
				return resp
			}
			time.Sleep(time.Millisecond)
		}
	}

	done := ask([]string{"A", "B"})
	if resp := answerUntilTaken(daemonruntime.AnswerQuestionRequest{TaskID: "task_1", QuestionID: "q1", Option: 1}); !resp.Answered || resp.Answer != "B" {
		t.Fatalf("choice response = %#v", resp)
	}
	if answer := <-done; answer.Text != "B" || answer.Option != 1 {
		t.Fatalf("choice answer = %#v", answer)
	}

	done = ask(nil)
	if resp := answerUntilTaken(daemonruntime.AnswerQuestionRequest{TaskID: "task_1", QuestionID: "q1", Text: " later "}); !resp.Answered || resp.Answer != "later" {
		t.Fatalf("typed response = %#v", resp)
	}
	if answer := <-done; answer.Text != "later" || !answer.Typed() {
		t.Fatalf("typed answer = %#v", answer)
	}

	if resp, _ := r.answerQuestion(context.Background(), daemonruntime.AnswerQuestionRequest{TaskID: "task_1", QuestionID: "q1", Option: 0}); resp.Answered {
		t.Fatalf("answer to a closed question = %#v", resp)
	}
}
