package llm

import "context"

// Message kinds a caller can attach to a request, so code observing the request (usage records, the
// context inspector) can tell its parts apart. Providers never see them.
const (
	MessageKindSystem  = "system"
	MessageKindSummary = "summary"
	MessageKindHistory = "history"
	MessageKindMeta    = "meta"
	MessageKindCurrent = "current"
	MessageKindStep    = "step"
)

// RequestLayout says what each message of a request is: MessageKinds[i] is the kind of
// Messages[i].
type RequestLayout struct {
	MessageKinds []string
}

type requestLayoutKey struct{}

// WithRequestLayout attaches the layout of the request about to be sent.
func WithRequestLayout(ctx context.Context, layout RequestLayout) context.Context {
	return context.WithValue(ctx, requestLayoutKey{}, layout)
}

// RequestLayoutFromContext returns the layout attached for this request, if any.
func RequestLayoutFromContext(ctx context.Context) (RequestLayout, bool) {
	if ctx == nil {
		return RequestLayout{}, false
	}
	layout, ok := ctx.Value(requestLayoutKey{}).(RequestLayout)
	return layout, ok
}
