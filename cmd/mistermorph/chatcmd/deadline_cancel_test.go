package chatcmd

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type deadlineCancelClient func(context.Context, llm.Request) (llm.Result, error)

func (f deadlineCancelClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	return f(ctx, req)
}

func TestChatCancellationReachesDeadlineConclusion(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		name := "stop"
		if shutdown {
			name = "shutdown"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				stopCtx, stopCancel := context.WithCancelCause(context.Background())
				defer stopCancel(nil)
				turnCtx, timeoutCancel := chatTimeoutContext(stopCtx, time.Second)
				defer timeoutCancel()
				active := &activeChatTurn{cancel: stopCancel, timeoutCancel: timeoutCancel}
				summarizing := make(chan struct{})
				calls := 0
				client := deadlineCancelClient(func(ctx context.Context, _ llm.Request) (llm.Result, error) {
					calls++
					if calls == 1 {
						<-ctx.Done()
						return llm.Result{}, ctx.Err()
					}
					close(summarizing)
					select {
					case <-ctx.Done():
						return llm.Result{}, ctx.Err()
					case <-time.After(time.Minute):
						return llm.Result{}, errors.New("summary did not receive cancellation")
					}
				})
				engine := agent.New(client, tools.NewRegistry(), agent.Config{MaxSteps: 2}, agent.DefaultPromptSpec())
				resultCh := make(chan chatTurnResult, 1)
				var runErr error
				var final *agent.Final
				go func() {
					final, _, runErr = engine.Run(turnCtx, "work", agent.RunOptions{})
					resultCh <- chatTurnResult{turn: active, final: final, err: runErr}
				}()
				<-summarizing
				start := time.Now()
				if shutdown {
					cancelAndWaitActiveChatTurn(active, resultCh)
				} else {
					active.requestStop()
					<-resultCh
				}
				if elapsed := time.Since(start); elapsed != 0 {
					t.Errorf("cancellation waited %s for the summary request", elapsed)
				}
				if !errors.Is(runErr, context.Canceled) || final != nil {
					t.Errorf("final=%+v error=%v; want cancellation without a final answer", final, runErr)
				}
			})
		})
	}
}
