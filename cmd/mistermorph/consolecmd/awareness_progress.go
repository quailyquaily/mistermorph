package consolecmd

import (
	"context"
	"log/slog"
	"sync"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/streaming"
	"github.com/quailyquaily/mistermorph/llm"
)

// consoleAwarenessProgress shows a heartbeat or TODO run in the awareness topic the way a chat
// task shows: its plan, activity, reasoning and reply stream live, and stay in the task result.
type consoleAwarenessProgress struct {
	taskID        string
	hub           *consoleStreamHub
	logger        *slog.Logger
	replySink     *consoleReplySink
	reasoningSink *consoleReasoningSink
	previewSink   *consoleEventPreviewSink
	trace         *chattrace.Collector
	streamer      *streaming.FinalOutputStreamer
	tracker       *consoleStreamTracker

	mu       sync.Mutex
	activity *consoleActivityProgress
	closed   bool
}

func newConsoleAwarenessProgressFunc(hub *consoleStreamHub, outputGuard *guard.Guard, fileCacheDir, fileStateDir string) awareness.TaskProgressFunc {
	if hub == nil {
		return nil
	}
	return func(taskID, workspaceDir string, logger *slog.Logger) awareness.TaskProgress {
		if logger == nil {
			logger = slog.Default()
		}
		logger = logger.With("task_id", taskID)
		p := &consoleAwarenessProgress{
			taskID:        taskID,
			hub:           hub,
			logger:        logger,
			replySink:     newConsoleReplySink(hub, taskID, logger, outputGuard),
			reasoningSink: newConsoleReasoningSink(hub, taskID, outputGuard),
			previewSink:   newConsoleEventPreviewSink(hub, taskID, logger, outputGuard),
			trace:         newConsoleChatTrace(taskID, pathroots.New(workspaceDir, fileCacheDir, fileStateDir), outputGuard, hub),
			tracker:       newConsoleStreamTracker(logger, taskID),
		}
		p.previewSink.activityUpdated = func(progress *consoleActivityProgress) {
			p.mu.Lock()
			p.activity = cloneConsoleActivityProgress(progress)
			p.mu.Unlock()
		}
		p.streamer = streaming.NewFinalOutputStreamer(streaming.FinalOutputStreamerOptions{
			Sink:        p.replySink,
			MinInterval: consoleReplySnapshotInterval,
		})
		hub.PublishStatus(taskID, string(daemonruntime.TaskRunning))
		return p
	}
}

func (p *consoleAwarenessProgress) Context(ctx context.Context) context.Context {
	ctx = llmstats.WithRunID(ctx, p.taskID)
	ctx = agent.WithEventSinkContext(ctx, agent.EventSinkFunc(func(ctx context.Context, event agent.Event) {
		p.trace.HandleEvent(ctx, event)
		p.previewSink.HandleEvent(ctx, event)
	}))
	var insights []string
	ctx = taskruntime.WithInsightNotification(ctx, p.logger, taskruntime.InsightLimit, func(_ context.Context, _ int, text string) error {
		p.mu.Lock()
		insights = append(insights, text)
		sent := append([]string(nil), insights...)
		p.mu.Unlock()
		p.hub.PublishInsights(p.taskID, sent)
		return nil
	})
	return llmutil.WithRetryNotification(ctx, func(ctx context.Context, event llmutil.RetryEvent) {
		p.trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindLLMRetry, RunID: llmstats.RunIDFromContext(ctx), Text: event.StatusText()})
		p.previewSink.HandleRetry(ctx, event)
	})
}

func (p *consoleAwarenessProgress) OnStream(event llm.StreamEvent) error {
	if err := p.reasoningSink.Handle(event); err != nil {
		return err
	}
	return p.tracker.Handle(event, p.streamer.Handle)
}

func (p *consoleAwarenessProgress) PlanStepUpdate(runCtx *agent.Context, _ agent.PlanStepUpdate) {
	plan := consoleTaskPlan(nil, runCtx)
	p.trace.RecordPlan(plan)
	if progress := buildConsolePlanProgress(plan); progress != nil {
		p.hub.PublishPlan(p.taskID, progress)
	}
}

func (p *consoleAwarenessProgress) Result(final *agent.Final, runCtx *agent.Context) map[string]any {
	p.previewSink.Close()
	p.mu.Lock()
	activity := cloneConsoleActivityProgress(p.activity)
	p.mu.Unlock()
	result := buildConsoleTaskResult(final, runCtx, activity, p.reasoningSink.Snapshot())
	delete(result, "final")
	result["trace"] = p.trace.Snapshot()
	return result
}

func (p *consoleAwarenessProgress) Close(output string, runErr error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.mu.Unlock()
	p.previewSink.Close()
	if runErr != nil {
		_ = p.replySink.Abort(context.Background(), runErr)
		p.tracker.LogSummary("failed")
		return
	}
	_ = p.replySink.Finalize(context.Background(), output)
	p.tracker.LogSummary("done")
}
