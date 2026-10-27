package consolecmd

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate"
)

// openCard starts an approval on a task's cards and waits for its card to appear. It returns the
// card, the approver's result channel and the task's cards.
func openCard(t *testing.T, e *consoleElevations, ctx context.Context) (consoleElevation, chan approverResult, *consoleTaskElevations) {
	t.Helper()
	hub := newConsoleStreamHub()
	cards := &consoleTaskElevations{taskID: "task_1", hub: hub}
	approver := e.approver(cards)
	result := make(chan approverResult, 1)
	go func() {
		password, err := approver.Approve(ctx, elevate.Request{
			Command:  "apt-get install -y jq",
			Dir:      "/srv/app",
			Deadline: time.Now().Add(time.Minute),
			Attempt:  1,
		})
		result <- approverResult{password, err}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if frame, ok := hub.Latest("task_1"); ok && len(frame.Elevations) == 1 {
			return frame.Elevations[0], result, cards
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no approval card was published")
	return consoleElevation{}, nil, nil
}

type approverResult struct {
	password string
	err      error
}

func TestConsoleElevationCards(t *testing.T) {
	cases := []struct {
		name       string
		req        daemonruntime.AnswerElevationRequest
		wantErr    string // from the answer call
		wantResult func(r approverResult) bool
		wantStatus string
	}{
		{
			name:       "allowed",
			req:        daemonruntime.AnswerElevationRequest{Password: "hunter2", Client: "web", Remote: "203.0.113.9:1234"},
			wantResult: func(r approverResult) bool { return r.err == nil && r.password == "hunter2" },
			wantStatus: consoleElevationAllowed,
		},
		{
			name:       "declined",
			req:        daemonruntime.AnswerElevationRequest{Decline: true},
			wantResult: func(r approverResult) bool { return errors.Is(r.err, elevate.ErrDeclined) },
			wantStatus: consoleElevationDeclined,
		},
		{
			name:       "no password",
			req:        daemonruntime.AnswerElevationRequest{},
			wantErr:    "no password",
			wantResult: func(r approverResult) bool { return r.err != nil && r.password == "" },
			wantStatus: consoleElevationRejected,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newConsoleElevations(nil)
			card, result, cards := openCard(t, e, context.Background())
			if card.Status != consoleElevationOpen || card.Command != "apt-get install -y jq" || card.Cwd != "/srv/app" {
				t.Fatalf("card = %+v", card)
			}
			req := tc.req
			req.TaskID, req.ElevationID = "task_1", card.ID
			resp, err := e.answer(req)
			if tc.wantErr == "" && (err != nil || !resp.Accepted) {
				t.Fatalf("answer = %+v, %v", resp, err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("answer error = %v, want %q", err, tc.wantErr)
			}
			select {
			case r := <-result:
				if !tc.wantResult(r) {
					t.Fatalf("approver returned %q, %v", r.password, r.err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the approver still waits")
			}
			settled := cards.snapshot()[0]
			if settled.Status != tc.wantStatus {
				t.Fatalf("settled card = %+v, want status %s", settled, tc.wantStatus)
			}
			// Answered once: the same answer again finds nothing open.
			if resp, err := e.answer(req); err != nil || resp.Accepted {
				t.Fatalf("second answer = %+v, %v", resp, err)
			}
		})
	}
}

func TestConsoleElevationCardExpiresAndIgnoresOtherTasks(t *testing.T) {
	e := newConsoleElevations(nil)
	ctx, cancel := context.WithCancel(context.Background())
	card, result, cards := openCard(t, e, ctx)
	// An answer naming another task does not reach this card.
	if resp, err := e.answer(daemonruntime.AnswerElevationRequest{TaskID: "task_2", ElevationID: card.ID, Decline: true}); err != nil || resp.Accepted {
		t.Fatalf("answer for another task = %+v, %v", resp, err)
	}
	cancel()
	r := <-result
	if !errors.Is(r.err, elevate.ErrTimedOut) {
		t.Fatalf("approver error = %v, want ErrTimedOut", r.err)
	}
	if got := cards.snapshot()[0].Status; got != consoleElevationExpired {
		t.Fatalf("status = %q, want expired", got)
	}
	// An answer after it expired is not taken.
	late := daemonruntime.AnswerElevationRequest{TaskID: "task_1", ElevationID: card.ID, Password: "hunter2"}
	if resp, err := e.answer(late); err != nil || resp.Accepted {
		t.Fatalf("late answer = %+v, %v", resp, err)
	}
}

func TestConsoleAsksUserFromBothChats(t *testing.T) {
	for ref, want := range map[string]bool{"web/console/chat": true, "cli/chat": true, "web/console": false, "": false} {
		if got := consoleAsksUser(daemonruntime.TaskTrigger{Source: "ui", Ref: ref}); got != want {
			t.Errorf("consoleAsksUser(ref %q) = %v, want %v", ref, got, want)
		}
	}
	if consoleAsksUser(daemonruntime.TaskTrigger{Source: "cron", Ref: "cli/chat"}) {
		t.Error("a cron task asks its person")
	}
}
