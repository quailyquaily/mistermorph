package taskruntime

import "context"

type memoriesReadOnlyKey struct{}

// WithMemoriesReadOnly makes a run read the memories its audience may hear without saving or
// forgetting any, for runs no one asked for, such as awareness tasks.
func WithMemoriesReadOnly(ctx context.Context) context.Context {
	return context.WithValue(ctx, memoriesReadOnlyKey{}, true)
}

func memoriesReadOnlyFromContext(ctx context.Context) bool {
	readOnly, _ := ctx.Value(memoriesReadOnlyKey{}).(bool)
	return readOnly
}
