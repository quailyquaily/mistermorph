package worker

import "context"

type StartOptions[J any] struct {
	Ctx    context.Context
	Sem    chan struct{}
	Jobs   <-chan J
	Handle func(context.Context, J)
}

func Start[J any](opts StartOptions[J]) {
	go func() {
		for {
			select {
			case <-opts.Ctx.Done():
				return
			case job, ok := <-opts.Jobs:
				if !ok {
					return
				}
				select {
				case opts.Sem <- struct{}{}:
				case <-opts.Ctx.Done():
					return
				}
				func() {
					defer func() { <-opts.Sem }()
					opts.Handle(opts.Ctx, job)
				}()
			}
		}
	}()
}

func Enqueue[J any](ctx, workersCtx context.Context, jobs chan<- J, job J) error {
	if ctx == nil {
		ctx = workersCtx
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-workersCtx.Done():
		return workersCtx.Err()
	case jobs <- job:
		return nil
	}
}
