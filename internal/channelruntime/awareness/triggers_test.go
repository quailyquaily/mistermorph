package awareness

import (
	"context"
	"testing"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func TestAttachTriggersFeedsTheLoopChannels(t *testing.T) {
	t.Run("without jobs", func(t *testing.T) {
		opts := RunOptions{}
		triggers := AttachTriggers(&opts)
		if triggers.Poke == nil || opts.PokeRequests == nil {
			t.Fatalf("poke trigger = %v, channel = %v", triggers.Poke != nil, opts.PokeRequests != nil)
		}
		if triggers.CronRun != nil || opts.CronRequests != nil {
			t.Fatal("a loop without jobs got a job trigger")
		}
	})
	t.Run("with jobs", func(t *testing.T) {
		opts := RunOptions{CronEnabled: true}
		triggers := AttachTriggers(&opts)
		if triggers.CronRun == nil || opts.CronRequests == nil {
			t.Fatal("a loop with jobs got no job trigger")
		}
		go func() {
			req := <-opts.CronRequests
			req.RunID <- "run-1"
			req.Result <- nil
		}()
		runID, err := triggers.CronRun(context.Background(), cronstore.RunRequest{Task: cronstore.Task{ID: "job", Content: "x", Cron: "0 9 * * *"}})
		if err != nil || runID != "run-1" {
			t.Fatalf("CronRun = %q, %v", runID, err)
		}
		go func() {
			req := <-opts.PokeRequests
			req.Result <- nil
		}()
		if err := triggers.Poke(context.Background(), awarenessdomain.PokeInput{HasBody: true, BodyText: "wake"}); err != nil {
			t.Fatalf("Poke = %v", err)
		}
	})
	if got := AttachTriggers(nil); got.Poke != nil || got.CronRun != nil {
		t.Fatal("nil options got triggers")
	}
}
