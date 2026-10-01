// Package accountdmcmd runs heartbeat and cron next to `morph wechat` and `morph whatsapp`.
package accountdmcmd

import (
	"context"
	"errors"

	"github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/chatinfo"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/livesend"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/viper"
)

// Run starts the runtime, and when heartbeat or cron is enabled, the awareness runtime beside it
// sharing its task store. Heartbeat notifications go to the channel's notification targets
// through the running runtime; either ending stops both.
func Run(ctx context.Context, channel string, awarenessDeps awarenessruntime.Dependencies, deps accountdm.Dependencies, opts *accountdm.Options, run func(context.Context) error) error {
	hbCfg := channelopts.HeartbeatConfigFromViper()
	cronCfg := channelopts.CronConfigFromViper()
	if !(hbCfg.Enabled && hbCfg.Interval > 0) && !cronCfg.Enabled {
		return run(ctx)
	}
	if opts.TaskStore == nil {
		taskStore, err := daemonruntime.NewTaskViewForTarget(channel, opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: deps.TaskPersistenceTargets, TasksDir: deps.RuntimePaths.TasksDir,
			JournalDir: deps.RuntimePaths.JournalDir, RotateMaxBytes: deps.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
		opts.TaskStore = taskStore
	}
	awarenessDeps.RuntimeToolsConfig = toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
	awarenessDeps.RuntimePaths = deps.RuntimePaths
	awarenessDeps.DefaultWorkspaceDir = deps.DefaultWorkspaceDir
	awarenessOpts := awarenessruntime.RunOptions{
		Interval:          hbCfg.Interval,
		TaskTimeout:       opts.TaskTimeout,
		RequestTimeout:    viper.GetDuration("llm.request_timeout"),
		AgentLimits:       opts.AgentLimits,
		EngineToolsConfig: opts.EngineToolsConfig,
		Source:            channel,
		ChecklistPath:     deps.RuntimePaths.HeartbeatPath,
		DisableHeartbeat:  !hbCfg.Enabled || hbCfg.Interval <= 0,
		InspectPrompt:     opts.InspectPrompt,
		InspectRequest:    opts.InspectRequest,
		Notifier: awarenessruntime.NotifyFunc(func(ctx context.Context, text string) error {
			return livesend.Notify(ctx, channel, text)
		}),
		CronEnabled:       cronCfg.Enabled,
		CronPath:          deps.RuntimePaths.CronPath,
		ChatInfoRefresher: chatinfo.NewFetcher(chatinfo.FetcherOptionsFromReader(viper.GetViper())),
		TaskStore:         opts.TaskStore,
	}
	pokeRequests := make(chan awarenessruntime.PokeRequest)
	awarenessOpts.PokeRequests = pokeRequests
	opts.Poke = func(ctx context.Context, input awareness.PokeInput) error {
		return awarenessruntime.Trigger(ctx, pokeRequests, input)
	}
	if cronCfg.Enabled {
		cronRequests := make(chan awarenessruntime.CronRequest)
		awarenessOpts.CronRequests = cronRequests
		opts.CronRun = func(ctx context.Context, task cronstore.Task) error {
			return awarenessruntime.TriggerCron(ctx, cronRequests, task)
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	errCh := make(chan error, 2)
	go func() { errCh <- run(runCtx) }()
	go func() { errCh <- awarenessruntime.Run(runCtx, awarenessDeps, awarenessOpts) }()
	var firstErr error
	for i := 0; i < 2; i++ {
		err := <-errCh
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
		cancel()
	}
	return firstErr
}
