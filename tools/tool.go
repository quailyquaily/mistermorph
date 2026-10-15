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
