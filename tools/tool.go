package tools

import "context"

type Tool interface {
	Name() string
	Description() string
	ParameterSchema() string
	Execute(ctx context.Context, params map[string]any) (string, error)
}

// ParallelSafe is an optional capability for tools that are read-only and
// safe to execute concurrently with other ParallelSafe tools in one batch.
// Tools without this capability run in provider order.
type ParallelSafe interface {
	ParallelSafe() bool
}

// Deferred is an optional capability for tools the model finds with tool_search instead of seeing
// in every request, like the runtime's MCP tools: for example, the many tools of an MCP client an
// embedder runs itself. It matters only when tool search is on. A wrapping tool must forward it.
type Deferred interface {
	Deferred() bool
}

// IsDeferred reports whether tool is Deferred and returns true.
func IsDeferred(tool Tool) bool {
	deferred, ok := tool.(Deferred)
	return ok && deferred.Deferred()
}

// CodeModeExcluded is an optional capability for tools a codemode script must not call, such as a
// tool that asks the user before it acts: the model calls it directly, so what the user sees is
// that tool's own call rather than a script. A wrapping tool must forward it.
type CodeModeExcluded interface {
	CodeModeExcluded() bool
}

// IsCodeModeExcluded reports whether tool is CodeModeExcluded and returns true.
func IsCodeModeExcluded(tool Tool) bool {
	excluded, ok := tool.(CodeModeExcluded)
	return ok && excluded.CodeModeExcluded()
}

// ApprovalPreviewer is an optional capability for a tool that always asks the user before it runs
// (see guard.RequiresForcedApproval). The engine calls ApprovalPreview before it asks: an error
// refuses the call without asking, and the preview is what the approval shows instead of the
// call's raw parameters, which may hold a secret. A wrapping tool must forward it.
type ApprovalPreviewer interface {
	ApprovalPreview(ctx context.Context, params map[string]any) (ApprovalPreview, error)
}

// ApprovalPreview describes what approving a call does.
type ApprovalPreview struct {
	// Summary is one line for approval prompts (chat channels, the terminal chat).
	Summary string
	// Params is what an approval card lists in place of the call's parameters.
	Params map[string]any
}

type userApprovalKey struct{}

// WithUserApproval marks ctx as the context of a call the user approved. The engine sets it when
// it runs a call after its approval; a tool that must never run unapproved checks UserApproved.
func WithUserApproval(ctx context.Context) context.Context {
	return context.WithValue(ctx, userApprovalKey{}, true)
}

// UserApproved reports whether ctx is the context of a call the user approved.
func UserApproved(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	approved, _ := ctx.Value(userApprovalKey{}).(bool)
	return approved
}
