package configtools

import "context"

// Reloader applies the saved config to the running runtime now, as a Console settings save does.
type Reloader func(ctx context.Context) error

type reloaderKey struct{}

// WithReloader gives config_set, for runs under ctx, a way to have the runtime reload the config
// right after a change. Without one, a runtime that watches its config (the Console, the channel
// runtimes) reloads it on its next check; others read it when they start.
func WithReloader(ctx context.Context, reload Reloader) context.Context {
	if reload == nil {
		return ctx
	}
	return context.WithValue(ctx, reloaderKey{}, reload)
}

func reloaderFrom(ctx context.Context) Reloader {
	if ctx == nil {
		return nil
	}
	reload, _ := ctx.Value(reloaderKey{}).(Reloader)
	return reload
}
