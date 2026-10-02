package llm

import (
	"context"
	"errors"
)

// ErrTokenCountUnsupported means the client, its provider or the request cannot be counted
// upstream; callers estimate instead.
var ErrTokenCountUnsupported = errors.New("token counting is not supported")

// TokenCounter is a client that can ask its provider how many input tokens a request holds, without
// running it.
type TokenCounter interface {
	CountTokens(ctx context.Context, req Request) (int, error)
}

// Unwrapper is a client that wraps another one (usage records, inspection, fallback). Wrappers
// expose it so callers can reach what the inner client can do.
type Unwrapper interface {
	Unwrap() Client
}

// CountTokens asks client, or the first client it wraps that can, to count req's input tokens.
func CountTokens(ctx context.Context, client Client, req Request) (int, error) {
	for depth := 0; client != nil && depth < 16; depth++ {
		if counter, ok := client.(TokenCounter); ok {
			return counter.CountTokens(ctx, req)
		}
		wrapper, ok := client.(Unwrapper)
		if !ok {
			break
		}
		client = wrapper.Unwrap()
	}
	return 0, ErrTokenCountUnsupported
}
