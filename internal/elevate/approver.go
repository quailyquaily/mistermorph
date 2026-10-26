package elevate

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrDeclined is what an Approver returns when the user refused the command.
	ErrDeclined = errors.New("declined")
	// ErrTimedOut is what an Approver returns when nobody answered by the request's deadline.
	ErrTimedOut = errors.New("timed out")
)

// Request is one ask for the password an elevated command needs.
type Request struct {
	// Command is what will run as root, for the user to read before approving.
	Command string
	// Dir is the working directory it runs in.
	Dir string
	// Deadline is when the ask gives up.
	Deadline time.Time
	// Attempt counts the asks for this command: 2 and up after sudo refused the password.
	Attempt int
}

// Approver asks the user to approve an elevated command and returns the password for sudo, or
// ErrDeclined or ErrTimedOut. ctx ends at the request's deadline, or sooner when the command is
// given up; the approver should stop asking then.
type Approver interface {
	Approve(ctx context.Context, req Request) (string, error)
}

// ApproverFunc lets a function be an Approver.
type ApproverFunc func(ctx context.Context, req Request) (string, error)

func (f ApproverFunc) Approve(ctx context.Context, req Request) (string, error) {
	return f(ctx, req)
}

type approverContextKey struct{}

// WithApprover makes approver ask for the elevated commands run with ctx, instead of the desktop
// dialog.
func WithApprover(ctx context.Context, approver Approver) context.Context {
	return context.WithValue(ctx, approverContextKey{}, approver)
}

// ApproverFromContext returns the approver WithApprover set on ctx.
func ApproverFromContext(ctx context.Context) (Approver, bool) {
	approver, ok := ctx.Value(approverContextKey{}).(Approver)
	return approver, ok && approver != nil
}

// dialogApprover asks in a dialog on this machine's desktop: the configured program, or the one
// chooseDialog finds.
type dialogApprover struct {
	configured string
}

func (d dialogApprover) Approve(ctx context.Context, req Request) (string, error) {
	dialog, err := chooseDialog(goos, d.configured)
	if err != nil {
		return "", err
	}
	text := approvalText(req.Command)
	if req.Attempt > 1 {
		text = "The password was not accepted. Try again.\n\n" + text
	}
	return dialog.ask(ctx, text)
}
