package agentlink

import "context"

type incomingHopKey struct{}

// WithIncomingHop marks ctx as running a task an Agent Link message with hop started.
func WithIncomingHop(ctx context.Context, hop int) context.Context {
	return context.WithValue(ctx, incomingHopKey{}, hop)
}

// IncomingHop is the hop of the Agent Link message that started the task in ctx, or 0 when no
// message started it.
func IncomingHop(ctx context.Context) int {
	if ctx == nil {
		return 0
	}
	hop, _ := ctx.Value(incomingHopKey{}).(int)
	return hop
}

// OutgoingHop is the hop of a message the task in ctx sends.
func OutgoingHop(ctx context.Context) int {
	return IncomingHop(ctx) + 1
}
