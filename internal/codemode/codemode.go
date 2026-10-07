// Package codemode runs a model-written JavaScript program that calls the agent's tools, on the
// moejs runtime. The host (the agent engine) decides and performs every operation; this package
// owns the JavaScript side: a fresh runtime per invocation, the bridge globals, ordering and
// concurrency of host operations, limits, cancellation and the result.
//
// The runtime runs inside the Go process. It limits what a script can reach, not how much memory
// it allocates; see MemoryWatcher.
package codemode

import (
	"context"
	"time"
)

// Fixed limits of one invocation.
const (
	MaxSourceBytes      = 64 << 10
	MaxArgBytes         = 256 << 10
	MaxResultBytes      = 1 << 20
	MaxTotalResultBytes = 8 << 20
	MaxOutputBytes      = 64 << 10
	MaxOutputItems      = 256
	MaxDepth            = 64
)

// Limits are an invocation's configurable bounds. All must be positive.
type Limits struct {
	Timeout      time.Duration
	MaxToolCalls int
	MaxParallel  int
}

// OpKind is what a host operation does.
type OpKind string

const (
	OpCall     OpKind = "call"
	OpSearch   OpKind = "search"
	OpDescribe OpKind = "describe"
)

// Op is one host operation a script issued. Its arguments are a frozen copy: later JavaScript
// changes cannot reach it.
type Op struct {
	// Index is the issue order within the invocation, from 0.
	Index int
	Kind  OpKind
	// Tool is the tool to call or describe.
	Tool string
	// Args are the call's arguments, decoded from ArgsJSON.
	Args     map[string]any
	ArgsJSON string
	// Query, Server and Limit are a search's parameters.
	Query  string
	Server string
	Limit  int
}

// DecisionKind is the host's answer to an operation before it starts.
type DecisionKind int

const (
	// Allow runs the operation.
	Allow DecisionKind = iota
	// Reject fails the operation's promise with Message without running it: an unknown or
	// excluded tool, or a guard deny. The script can catch it.
	Reject
	// RequireApproval stops the script; the model must make this call directly.
	RequireApproval
)

type Decision struct {
	Kind    DecisionKind
	Message string
}

// Host performs a script's operations. Check and Finish run on the invocation's goroutine, one at
// a time and in completion order; Run may run concurrently for operations ParallelSafe allows.
type Host interface {
	// Check decides an operation just before it would start.
	Check(ctx context.Context, op Op) Decision
	// ParallelSafe reports whether op may overlap other parallel-safe operations.
	ParallelSafe(op Op) bool
	// Run performs an allowed operation. A call returns the tool's text; a search or describe
	// returns JSON text.
	Run(ctx context.Context, op Op) (string, error)
	// Finish post-processes a finished operation (for example redaction) and returns what the
	// script may see. It also runs for operations whose result the script will never see.
	Finish(ctx context.Context, op Op, result string, err error) (string, error)
}

// Status is how an invocation ended.
type Status string

const (
	StatusCompleted          Status = "completed"
	StatusFailed             Status = "failed"
	StatusTimedOut           Status = "timed_out"
	StatusCancelled          Status = "cancelled"
	StatusOutputLimit        Status = "output_limit"
	StatusMemoryLimit        Status = "memory_limit"
	StatusRequiresDirectCall Status = "requires_direct_call"
)

// Outcome is how one operation ended.
type Outcome string

const (
	OutcomeSucceeded  Outcome = "succeeded"
	OutcomeFailed     Outcome = "failed"
	OutcomeDenied     Outcome = "denied"
	OutcomeNotStarted Outcome = "not_started"
	OutcomeCancelled  Outcome = "cancelled"
	// OutcomeRequiresApproval is the call the script stopped at; it did not run.
	OutcomeRequiresApproval Outcome = "requires_approval"
)

// OpRecord is one operation in the result.
type OpRecord struct {
	Index    int           `json:"index"`
	Kind     OpKind        `json:"kind"`
	Tool     string        `json:"tool,omitempty"`
	Query    string        `json:"query,omitempty"`
	Outcome  Outcome       `json:"outcome"`
	Error    string        `json:"error,omitempty"`
	Duration time.Duration `json:"-"`
}

// PendingCall is the call the model must make directly after an approval handoff.
type PendingCall struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"arguments"`
}

// MemoryUsage is approximate: other work in the process allocates at the same time.
type MemoryUsage struct {
	PeakHeapGrowthBytes uint64 `json:"approx_peak_heap_growth_bytes"`
	AllocatedBytes      uint64 `json:"approx_allocated_bytes"`
}

// Result is the outcome of one invocation.
type Result struct {
	Status  Status        `json:"status"`
	Output  []string      `json:"output"`
	Error   string        `json:"error,omitempty"`
	Ops     []OpRecord    `json:"calls"`
	Pending *PendingCall  `json:"pending_call,omitempty"`
	Elapsed time.Duration `json:"-"`
	Memory  MemoryUsage   `json:"memory"`
}
