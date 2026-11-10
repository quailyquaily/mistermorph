package awareness

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/audience"
	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/awarenessutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chatinfo"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/memories"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type RunOptions struct {
	Interval          time.Duration
	TaskTimeout       time.Duration
	RequestTimeout    time.Duration
	AgentLimits       agent.Limits
	EngineToolsConfig agent.EngineToolsConfig
	Source            string
	ChecklistPath     string
	DisableHeartbeat  bool
	InspectPrompt     bool
	InspectRequest    bool
	Notifier          Notifier
	CronNotify        CronNotifyFunc
	PokeRequests      <-chan PokeRequest
	CronRequests      <-chan CronRequest
	CronEnabled       bool
	// CronMaxConcurrency is how many TODO items may run at once (default 8).
	CronMaxConcurrency int
	CronPath           string
	// TopicContextScope, when set, says where a run recorded under a topic keeps its context usage,
	// for a runtime that shows it per topic.
	TopicContextScope func(topicID string) topiccontext.Scope
	// TopicRunStarted, when set, is told of each run once it is recorded under its topic.
	TopicRunStarted     func(TopicRun)
	ChatInfoContactsDir string
	// ChatInfoStateDir is the state folder whose agent.db keeps the contacts of
	// ChatInfoContactsDir.
	ChatInfoStateDir  string
	ChatInfoStore     *chatinfo.Store
	ChatInfoRefresher chatinfo.Refresher
	TaskStore         daemonruntime.TaskView
	// TaskProgress, when set, follows each recorded run while it works.
	TaskProgress TaskProgressFunc
}

// TaskProgress follows one awareness run while it works, for a runtime that can show its plan,
// activity, reasoning and reply as they happen, such as the Console.
type TaskProgress interface {
	// Context attaches what the run reports through its context, such as agent events.
	Context(ctx context.Context) context.Context
	OnStream(event llm.StreamEvent) error
	PlanStepUpdate(runCtx *agent.Context, update agent.PlanStepUpdate)
	// Result returns the fields to keep in the task result beside "final".
	Result(final *agent.Final, runCtx *agent.Context) map[string]any
	// Close ends the live view once the task record holds the outcome.
	Close(output string, runErr error)
}

// TaskProgressFunc starts following the run recorded as taskID.
type TaskProgressFunc func(taskID, workspaceDir string, logger *slog.Logger) TaskProgress

type Dependencies = depsutil.CommonDependencies

func awarenessTaskRunID(behavior awarenessutil.Behavior, now time.Time) string {
	return fmt.Sprintf("%s:%s", behavior, now.UTC().Format("20060102T150405.000000000Z07:00"))
}

func Run(ctx context.Context, d Dependencies, opts RunOptions) error {
	if err := d.Validate(); err != nil {
		return err
	}
	return runAwarenessLoop(ctx, d, normalizeRunOptions(opts, d.RuntimePaths))
}

func runAwarenessLoop(ctx context.Context, d Dependencies, opts RunOptions) (runErr error) {
	if ctx == nil {
		ctx = context.Background()
	}
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	logOpts := agent.LogOptions{}
	if d.LogOptions != nil {
		logOpts = d.LogOptions()
	}

	route, err := d.ResolveLLMRoute(llmutil.RoutePurposeAwareness)
	if err != nil {
		return err
	}
	model := strings.TrimSpace(route.ClientConfig.Model)
	if model == "" {
		return fmt.Errorf("missing model")
	}
	inspectors, err := newAwarenessInspectors(opts)
	if err != nil {
		return err
	}
	defer func() {
		if inspectors != nil {
			_ = inspectors.Close()
		}
	}()
	var (
		client                   llm.Client
		systemPromptCacheControl *llm.CacheControl
	)
	if len(route.Candidates) == 0 {
		systemPromptCacheControl, err = llmutil.SystemPromptCacheControl(route.Values.CacheTTL)
		if err != nil {
			return err
		}
		client, err = d.CreateLLMClient(route)
		if err != nil {
			var closeErr error
			if closer, ok := client.(io.Closer); ok {
				closeErr = closer.Close()
			}
			if closeErr != nil {
				closeErr = fmt.Errorf("close awareness LLM client after creation failure: %w", closeErr)
			}
			return errors.Join(err, closeErr)
		}
		client = inspectors.Wrap(client, route)
		if closer, ok := client.(io.Closer); ok {
			defer func() {
				if err := closer.Close(); err != nil {
					runErr = errors.Join(runErr, fmt.Errorf("close awareness LLM client: %w", err))
				}
			}()
		}
	}

	var baseReg *tools.Registry
	if d.AwarenessRegistry != nil {
		baseReg = d.AwarenessRegistry()
	}
	if baseReg == nil {
		if d.Registry != nil {
			baseReg = d.Registry()
		}
	}
	if baseReg == nil {
		return fmt.Errorf("base registry is nil")
	}
	var sharedGuard *guard.Guard
	if d.Guard != nil {
		sharedGuard, err = d.Guard(logger)
		if err != nil {
			return fmt.Errorf("initialize awareness guard: %w", err)
		}
	}
	if sharedGuard != nil {
		defer func() {
			if err := sharedGuard.Close(); err != nil {
				runErr = errors.Join(runErr, fmt.Errorf("close awareness guard: %w", err))
			}
		}()
	}
	cfg := opts.AgentLimits.ToConfig()

	state := &awarenessutil.State{}
	var wg sync.WaitGroup
	chatInfoStore, chatInfoRefresher := resolveChatInfoRuntime(opts)
	if opts.CronEnabled {
		refreshChatInfoOnStart(ctx, chatInfoStore, chatInfoRefresher, opts.ChatInfoStateDir, opts.ChatInfoContactsDir, logger)
	}

	// runCtx is the run's own context: a cron item's execution context, so stopping it ends the run.
	runAwarenessTaskWithOpts := func(runCtx context.Context, behavior awarenessutil.Behavior, task string, meta map[string]any, taskRunID, llmProfile, workspaceDir string, bashEnv []cronstore.BashEnvRef, topicID, topicTitle string, cronManual bool) (string, error) {
		var contextScope topiccontext.Scope
		if topicID != "" && opts.TopicContextScope != nil {
			contextScope = opts.TopicContextScope(topicID)
		}
		return runAwarenessTask(runCtx, d, awarenessTaskOptions{
			Behavior:                 behavior,
			Logger:                   logger,
			LogOptions:               logOpts,
			Client:                   client,
			Route:                    route,
			Model:                    model,
			Task:                     task,
			Meta:                     meta,
			TaskRunID:                taskRunID,
			LLMProfile:               llmProfile,
			WorkspaceDir:             workspaceDir,
			BaseRegistry:             baseReg,
			SharedGuard:              sharedGuard,
			Config:                   cfg,
			EngineToolsConfig:        opts.EngineToolsConfig,
			TaskTimeout:              opts.TaskTimeout,
			SystemPromptCacheControl: systemPromptCacheControl,
			ClientDecorator:          inspectors.Wrap,
			ImageClient:              nil,
			TaskStore:                opts.TaskStore,
			TaskProgress:             opts.TaskProgress,
			BashEnv:                  bashEnv,
			TopicID:                  topicID,
			TopicTitle:               topicTitle,
			ContextScope:             contextScope,
			TopicRunStarted:          opts.TopicRunStarted,
			CronManual:               cronManual,
		})
	}
	runTask := func(runCtx context.Context, behavior awarenessutil.Behavior, task string, meta map[string]any, taskRunID string) (string, error) {
		return runAwarenessTaskWithOpts(runCtx, behavior, task, meta, taskRunID, "", "", nil, "", "", false)
	}

	runTaskAsync := func(behavior awarenessutil.Behavior, task string, taskEmpty bool, wakeSignal awarenessdomain.PokeInput) string {
		if ctx.Err() != nil {
			return "context_canceled"
		}
		runAt := time.Now().UTC()
		taskRunID := awarenessTaskRunID(behavior, runAt)
		extra := map[string]any{
			"task_run_id": taskRunID,
		}
		meta := awarenessutil.BuildAwarenessMeta(behavior, opts.Source, opts.Interval, opts.ChecklistPath, taskEmpty, wakeSignal, extra)
		wg.Add(1)
		go func() {
			defer wg.Done()

			summary, runErr := runTask(ctx, behavior, task, meta, taskRunID)
			if runErr != nil {
				displayErr := depsutil.FormatRuntimeError(runErr)
				alert, alertMsg := state.EndFailure(errors.New(displayErr))
				if alert {
					logger.Warn("awareness_alert", "source", opts.Source, "behavior", behavior, "message", alertMsg)
					notifyAwareness(ctx, opts.Notifier, logger, alertMsg)
					return
				}
				logger.Warn("awareness_error", "source", opts.Source, "behavior", behavior, "error", displayErr)
				return
			}
			state.EndSuccess(time.Now())
			if summary == "" {
				summary = "empty"
			}
			logger.Info("awareness_summary", "source", opts.Source, "behavior", behavior, "message", summary)
		}()
		return ""
	}

	runTick := func(behavior awarenessutil.Behavior, wakeSignal awarenessdomain.PokeInput) awarenessutil.TickResult {
		result := awarenessutil.Tick(
			state,
			behavior,
			func() (string, bool, error) {
				return awarenessutil.BuildAwarenessTask(behavior, opts.ChecklistPath, wakeSignal)
			},
			func(task string, taskEmpty bool) string {
				return runTaskAsync(behavior, task, taskEmpty, wakeSignal)
			},
		)
		switch result.Outcome {
		case awarenessutil.TickBuildError:
			if strings.TrimSpace(result.AlertMessage) != "" {
				logger.Warn("awareness_alert", "source", opts.Source, "behavior", behavior, "message", result.AlertMessage)
				notifyAwareness(ctx, opts.Notifier, logger, result.AlertMessage)
			} else if result.BuildError != nil {
				logger.Warn("awareness_task_error", "source", opts.Source, "behavior", behavior, "error", result.BuildError.Error())
			}
		case awarenessutil.TickSkipped:
			logger.Debug("awareness_skip", "source", opts.Source, "behavior", behavior, "reason", result.SkipReason)
		}
		return result
	}

	if opts.CronEnabled {
		cronPath := strings.TrimSpace(opts.CronPath)
		systemTasks := []cronstore.Task{}
		if !opts.DisableHeartbeat && opts.Interval > 0 {
			heartbeatCron, usedInterval, fallbackUsed, ok := cronstore.HeartbeatIntervalScheduleWithFallback(opts.Interval, DefaultHeartbeatInterval)
			if ok {
				if fallbackUsed {
					logger.Warn("heartbeat_interval_fallback", "source", opts.Source, "interval", opts.Interval.String(), "fallback_interval", usedInterval.String(), "cron", heartbeatCron)
				}
				systemTasks = append(systemTasks, cronstore.HeartbeatTask(heartbeatCron))
			} else {
				logger.Warn("heartbeat_interval_invalid", "source", opts.Source, "interval", opts.Interval.String())
			}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			RunCronLoop(ctx, CronLoopOptions{
				Logger:      logger,
				Source:      opts.Source,
				Path:        cronPath,
				SystemTasks: systemTasks,
				Requests:    opts.CronRequests,
				// The heartbeat runs in its own lane beside these.
				MaxConcurrency: opts.CronMaxConcurrency,
				Run: func(ctx context.Context, due cronstore.DueTask) error {
					task := due.Task
					if strings.TrimSpace(task.ID) == cronstore.HeartbeatTaskID {
						taskText, empty, err := awarenessutil.BuildHeartbeatTask(opts.ChecklistPath)
						if err != nil {
							return err
						}
						if empty || strings.TrimSpace(taskText) == "" {
							logger.Debug("awareness_skip", "source", opts.Source, "behavior", awarenessutil.BehaviorHeartbeat, "reason", awarenessutil.SkipReasonEmptyTask)
							return nil
						}
						taskRunID := awarenessTaskRunID(awarenessutil.BehaviorHeartbeat, time.Now().UTC())
						meta := awarenessutil.BuildAwarenessMeta(awarenessutil.BehaviorHeartbeat, opts.Source, opts.Interval, opts.ChecklistPath, false, awarenessdomain.PokeInput{}, map[string]any{
							"task_run_id":           taskRunID,
							"cron_task_id":          cronstore.HeartbeatTaskID,
							"cron_schedule":         cronstore.ScheduleForTask(task),
							"cron_scheduled_at_utc": due.ScheduledAtUTC.UTC().Format(time.RFC3339),
							"runtime_source":        strings.TrimSpace(opts.Source),
						})
						summary, err := runTask(ctx, awarenessutil.BehaviorHeartbeat, strings.TrimSpace(taskText), meta, taskRunID)
						if err != nil {
							return err
						}
						if summary == "" {
							summary = "empty"
						}
						logger.Info("awareness_summary", "source", opts.Source, "behavior", awarenessutil.BehaviorHeartbeat, "task_id", cronstore.HeartbeatTaskID, "message", summary)
						return nil
					}
					taskRunID := awarenessTaskRunID(awarenessutil.BehaviorCron, time.Now().UTC())
					extra := map[string]any{
						"task_run_id":    taskRunID,
						"runtime_source": strings.TrimSpace(opts.Source),
					}
					if profile := strings.TrimSpace(task.LLMProfile); profile != "" {
						extra["llm_profile"] = profile
					}
					if dir := strings.TrimSpace(task.WorkspaceDir); dir != "" {
						extra["workspace_dir"] = dir
					}
					if !cronstore.IsConsoleNotificationChatID(task.ChatID) {
						if notifyTarget := buildCronNotifyTargetForTask(ctx, task, time.Now().UTC(), chatInfoStore, chatInfoRefresher, logger); notifyTarget != nil {
							extra["notify_target"] = notifyTarget
						}
					}
					meta := awarenessutil.BuildCronMeta("cron", strings.TrimSpace(task.ID), due.ScheduledAtUTC, cronstore.ScheduleForTask(task), strings.TrimSpace(task.TZ), strings.TrimSpace(task.ChatID), extra)
					summary, err := runAwarenessTaskWithOpts(ctx, awarenessutil.BehaviorCron, strings.TrimSpace(task.Content), meta, taskRunID, task.LLMProfile, task.WorkspaceDir, task.BashEnv,
						daemonruntime.CronTopicID(task.ID), cronTopicTitle(task), due.Manual)
					if err != nil {
						if errors.Is(context.Cause(ctx), cronstore.ErrRunStopped) {
							err = cronstore.ErrRunStopped
						}
						notifyCronResult(ctx, opts.CronNotify, logger, task, due.Manual, taskRunID, "", err)
						return err
					}
					if summary == "" {
						summary = "empty"
					}
					notifyCronResult(ctx, opts.CronNotify, logger, task, due.Manual, taskRunID, summary, nil)
					logger.Info("awareness_summary", "source", opts.Source, "behavior", awarenessutil.BehaviorCron, "task_id", strings.TrimSpace(task.ID), "message", summary)
					if !due.Manual && strings.TrimSpace(task.At) != "" {
						if _, deleteErr := cronstore.NewStore(cronPath).DeleteByID(task.ID); deleteErr != nil {
							return deleteErr
						}
					}
					return nil
				},
			})
		}()
	}

	RunPokeLoop(ctx, opts.PokeRequests, func(input awarenessdomain.PokeInput) awarenessutil.TickResult {
		return runTick(awarenessutil.BehaviorPoke, input)
	})
	wg.Wait()
	return nil
}

type awarenessTaskOptions struct {
	Behavior   awarenessutil.Behavior
	Logger     *slog.Logger
	LogOptions agent.LogOptions
	Client     llm.Client
	Route      llmutil.ResolvedRoute
	Model      string
	Task       string
	Meta       map[string]any
	TaskRunID  string
	LLMProfile string
	// WorkspaceDir, when set, replaces the default workspace for this run.
	WorkspaceDir             string
	BaseRegistry             *tools.Registry
	SharedGuard              *guard.Guard
	Config                   agent.Config
	EngineToolsConfig        agent.EngineToolsConfig
	TaskTimeout              time.Duration
	SystemPromptCacheControl *llm.CacheControl
	ClientDecorator          func(llm.Client, llmutil.ResolvedRoute) llm.Client
	ImageClient              llm.ImageClient
	TaskStore                daemonruntime.TaskView
	TaskProgress             TaskProgressFunc
	BashEnv                  []cronstore.BashEnvRef
	// TopicID records the run under this topic instead of Awareness, and TopicTitle names it:
	// a TODO item's runs go to the item's own topic.
	TopicID    string
	TopicTitle string
	// ContextScope, when it has a conversation key, records the run's context usage under it.
	ContextScope topiccontext.Scope
	// TopicRunStarted is told of the run once it is recorded under TopicID.
	TopicRunStarted func(TopicRun)
	// CronManual marks a TODO item's run a person asked for, rather than one its schedule fired.
	CronManual bool
}

// TopicRun is a run recorded under a topic, as it starts.
type TopicRun struct {
	TopicID string
	Task    string
	// WorkspaceDir is the workspace the run's item sets, if it sets one.
	WorkspaceDir string
	Provider     string
	Model        string
}

func runAwarenessTask(ctx context.Context, d Dependencies, opts awarenessTaskOptions) (summary string, runErr error) {
	task := strings.TrimSpace(opts.Task)
	if task == "" {
		return "", fmt.Errorf("awareness task is empty")
	}
	workspaceDir := firstNonEmpty(opts.EngineToolsConfig.PathRoots.WorkspaceDir, d.DefaultWorkspaceDir)
	if taskWorkspaceDir := strings.TrimSpace(opts.WorkspaceDir); taskWorkspaceDir != "" {
		resolved, err := workspace.ValidateDir(taskWorkspaceDir, nil)
		if err != nil {
			return "", err
		}
		workspaceDir = resolved
	}
	ctx = pathroots.WithWorkspaceDir(ctx, workspaceDir)
	if opts.ContextScope.ConversationKey != "" {
		ctx = topiccontext.WithScope(ctx, opts.ContextScope)
	}
	routePurpose := ""
	reasoningEffort := ""
	if thinkTask, ok := chatcommands.ExtractThinkTask(task); ok {
		task = strings.TrimSpace(thinkTask)
		routePurpose = llmutil.RoutePurposeThink
		reasoningEffort = llmutil.ReasoningEffortXHigh
		if task == "" {
			return "", fmt.Errorf("awareness task is empty")
		}
	}

	taskClient := opts.Client
	taskModel := strings.TrimSpace(opts.Model)
	systemPromptCacheControl := opts.SystemPromptCacheControl
	llmProfile := strings.TrimSpace(opts.LLMProfile)
	var taskRoute llmutil.ResolvedRoute
	useTaskRoute := false
	if llmProfile != "" {
		profileRoutePurpose := routePurpose
		if profileRoutePurpose == "" {
			profileRoutePurpose = llmutil.RoutePurposeAwareness
		}
		if d.ResolveLLMRouteWithProfile == nil {
			return "", fmt.Errorf("resolve LLM route with profile dependency is missing")
		}
		var err error
		taskRoute, err = d.ResolveLLMRouteWithProfile(profileRoutePurpose, llmProfile)
		if err != nil {
			var missingProfile *llmutil.MissingProfileError
			if errors.As(err, &missingProfile) && strings.TrimSpace(missingProfile.Profile) == llmProfile {
				if opts.Logger != nil {
					opts.Logger.Warn("cron_llm_profile_invalid",
						"profile", llmProfile,
						"task_run_id", strings.TrimSpace(opts.TaskRunID),
						"fallback", "route_default",
						"error", err.Error(),
					)
				}
				llmProfile = ""
			} else {
				return "", fmt.Errorf("resolve llm profile %q: %w", llmProfile, err)
			}
		} else {
			useTaskRoute = true
		}
	}
	if !useTaskRoute && routePurpose != "" {
		var err error
		taskRoute, err = d.ResolveLLMRoute(routePurpose)
		if err != nil {
			return "", err
		}
		useTaskRoute = true
	}
	if !useTaskRoute && len(opts.Route.Candidates) > 0 {
		taskRoute = opts.Route
		useTaskRoute = true
	}
	if useTaskRoute {
		selectionKey := strings.TrimSpace(opts.TaskRunID)
		if selectionKey == "" {
			selectionKey = strings.TrimSpace(llmstats.RunIDFromContext(ctx))
		}
		if selectionKey == "" {
			selectionKey = strings.TrimSpace(llmstats.OriginEventIDFromContext(ctx))
		}
		taskRoute = llmutil.SelectRouteCandidate(taskRoute, selectionKey)
		if reasoningEffort != "" {
			taskRoute = llmutil.ResolvedRouteWithReasoningEffort(taskRoute, reasoningEffort)
		}
		taskModel = strings.TrimSpace(taskRoute.ClientConfig.Model)
	}
	recordOpts := opts
	recordOpts.Model = taskModel
	if err := recordAwarenessTaskStart(recordOpts, task, time.Now().UTC()); err != nil {
		return "", fmt.Errorf("record awareness task start: %w", err)
	}
	if topicID := strings.TrimSpace(opts.TopicID); topicID != "" && opts.TopicRunStarted != nil {
		route := opts.Route
		if useTaskRoute {
			route = taskRoute
		}
		opts.TopicRunStarted(TopicRun{
			TopicID:      topicID,
			Task:         task,
			WorkspaceDir: strings.TrimSpace(opts.WorkspaceDir),
			Provider:     firstNonEmpty(route.Values.InferenceProvider, route.ClientConfig.Provider),
			Model:        taskModel,
		})
	}
	var progress TaskProgress
	if opts.TaskProgress != nil && opts.TaskStore != nil && strings.TrimSpace(opts.TaskRunID) != "" {
		progress = opts.TaskProgress(strings.TrimSpace(opts.TaskRunID), workspaceDir, opts.Logger)
	}
	var agentCtx *agent.Context
	taskRecordFinished := false
	defer func() {
		if taskRecordFinished {
			return
		}
		taskRecordFinished = true
		var extra map[string]any
		if progress != nil {
			extra = progress.Result(nil, agentCtx)
		}
		// A run someone stopped ends as stopped, whatever error the cancellation surfaced as.
		finishErr := runErr
		if finishErr != nil && errors.Is(context.Cause(ctx), cronstore.ErrRunStopped) {
			finishErr = cronstore.ErrRunStopped
		}
		if err := recordAwarenessTaskFinish(recordOpts, summary, extra, finishErr, time.Now().UTC()); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("record awareness task finish: %w", err))
		}
		if progress != nil {
			progress.Close(summary, finishErr)
		}
	}()

	if useTaskRoute {
		var err error
		taskClient, err = d.CreateLLMClient(taskRoute)
		if err != nil {
			return "", err
		}
		defer closeAwarenessTaskClient(opts.Logger, taskClient)
		if opts.ClientDecorator != nil {
			taskClient = opts.ClientDecorator(taskClient, taskRoute)
		}
		systemPromptCacheControl, err = llmutil.SystemPromptCacheControl(taskRoute.Values.CacheTTL)
		if err != nil {
			return "", err
		}
	}

	runCtx := ctx
	cancel := func() {}
	if opts.TaskTimeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, opts.TaskTimeout)
	}
	defer cancel()

	var toolTriggers map[string]bool
	if d.ToolTriggers != nil {
		toolTriggers = d.ToolTriggers(task)
	}
	if len(opts.BashEnv) > 0 {
		if toolTriggers == nil {
			toolTriggers = make(map[string]bool)
		}
		toolTriggers[toolsutil.BuiltinBash] = true
	}
	promptSpec, _, err := d.PromptSpec(runCtx, opts.Logger, opts.LogOptions, task, taskClient, taskModel, nil)
	if err != nil {
		return "", err
	}
	promptSpec.FinalOnlyResponse = true
	if block := workspace.PromptBlock(workspaceDir); strings.TrimSpace(block.Content) != "" {
		promptSpec.Blocks = append(promptSpec.Blocks, block)
	}

	reg := opts.BaseRegistry.Clone()
	if d.RegisterTriggeredStaticTools != nil {
		reg.Remove(toolsutil.BuiltinAgentSend)
		if toolTriggers == nil {
			toolTriggers = make(map[string]bool)
		}
		toolTriggers[toolsutil.BuiltinAgentSend] = true
	}
	if d.RegisterTriggeredStaticTools != nil && len(toolTriggers) > 0 {
		d.RegisterTriggeredStaticTools(reg, toolTriggers)
	}
	if len(opts.BashEnv) > 0 {
		injected, err := cronstore.ResolveBashEnvRefsWithOptions(opts.BashEnv, cronstore.BashEnvResolveOptions{
			Warnf: func(format string, args ...any) {
				if opts.Logger != nil {
					opts.Logger.Warn("cron_bash_env_secret_ref_warning", "warning", fmt.Sprintf(format, args...))
				}
			},
		})
		if err != nil {
			return "", err
		}
		if err := toolsutil.PatchBashInjectedEnv(reg, injected); err != nil {
			return "", err
		}
	}
	imageClient := opts.ImageClient
	imageToolTriggered := toolTriggers[toolsutil.BuiltinImageGenerate] || toolTriggers[toolsutil.BuiltinImageEdit]
	if d.RuntimeToolsConfig.Image.Configured && imageClient == nil && imageToolTriggered {
		if d.CreateImageClient != nil {
			var imageErr error
			imageClient, imageErr = d.CreateImageClient()
			if imageErr != nil {
				if closer, ok := imageClient.(io.Closer); ok && closer != nil {
					if closeErr := closer.Close(); closeErr != nil && opts.Logger != nil {
						opts.Logger.Warn("awareness_image_client_close_failed", "error", closeErr.Error())
					}
				}
				imageClient = nil
				if opts.Logger != nil {
					opts.Logger.Warn("image_client_create_failed", "error", imageErr.Error())
				}
			} else if closer, ok := imageClient.(io.Closer); ok && closer != nil {
				defer func() {
					if closeErr := closer.Close(); closeErr != nil && opts.Logger != nil {
						opts.Logger.Warn("awareness_image_client_close_failed", "error", closeErr.Error())
					}
				}()
			}
		}
	}
	toolsutil.RegisterRuntimeTools(reg, d.RuntimeToolsConfig, toolsutil.RuntimeToolLLMOptions{
		DefaultClient: taskClient,
		DefaultModel:  taskModel,
		ImageClient:   imageClient,
		ToolTriggers:  toolTriggers,
		PersonaDir:    d.RuntimePaths.PersonaDir,
	})
	// A heartbeat follows the owner's own checklist, so it reads the owner's memories, without
	// saving any: no one asked it anything. A cron task may have been set up from a contact's
	// conversation and may answer them, so it reads none.
	var memoryStore *memories.Store
	if opts.Behavior == awarenessutil.BehaviorHeartbeat {
		store, memErr := taskruntime.AttachMemories(runCtx, d.RuntimePaths, d.RuntimeToolsConfig.Memories, reg, audience.Owner(), true)
		if memErr != nil {
			return "", memErr
		}
		memoryStore = store
		defer func() { _ = memoryStore.Close() }()
	}
	// Heartbeat and cron tasks may load $mcp_<name> servers too, for this run only.
	registeredBefore := make(map[string]bool)
	for _, tool := range reg.All() {
		registeredBefore[tool.Name()] = true
	}
	if d.LoadReferencedMCP != nil {
		closeMCP, mcpErr := d.LoadReferencedMCP(runCtx, task, reg)
		if mcpErr != nil {
			return "", mcpErr
		}
		defer func() {
			if closeErr := closeMCP(); closeErr != nil && opts.Logger != nil {
				opts.Logger.Warn("awareness_mcp_close_failed", "error", closeErr.Error())
			}
		}()
	}
	// Tool search applies here too; awareness runs have no conversation to remember finds.
	var referenced []string
	for _, tool := range reg.All() {
		if !registeredBefore[tool.Name()] {
			referenced = append(referenced, tool.Name())
		}
	}
	toolSearchOption, closeToolSearch, searchErr := taskruntime.ToolSearchOption(reg, d.MCPServers, d.RuntimeToolsConfig.ToolSearch, referenced, opts.Logger)
	if searchErr != nil {
		return "", searchErr
	}
	defer func() {
		if closeErr := closeToolSearch(); closeErr != nil && opts.Logger != nil {
			opts.Logger.Warn("awareness_tool_search_close_failed", "error", closeErr.Error())
		}
	}()
	codeModeOption, codeModeErr := taskruntime.CodeModeOption(reg, d.RuntimeToolsConfig.CodeMode)
	if codeModeErr != nil {
		return "", codeModeErr
	}
	promptprofile.ApplyPersonaIdentity(&promptSpec, opts.Logger, d.RuntimePaths.PersonaDir)
	promptprofile.AppendPlanCreateGuidanceBlock(&promptSpec, reg)
	if d.PromptAugment != nil {
		d.PromptAugment(&promptSpec, reg)
	}
	taskruntime.AppendMemoriesPrompt(memoryStore, &promptSpec, audience.Owner(), true)
	promptprofile.AppendAwarenessPromptPatch(&promptSpec)
	promptprofile.AppendModelPromptPatches(&promptSpec, taskModel)
	engineToolsConfig := opts.EngineToolsConfig
	engineToolsConfig.ToolTriggers = toolTriggers
	engineToolsConfig.PathRoots = pathroots.New(
		workspaceDir,
		firstNonEmpty(engineToolsConfig.PathRoots.FileCacheDir, d.RuntimeToolsConfig.Image.FileCacheDir),
		firstNonEmpty(engineToolsConfig.PathRoots.FileStateDir, d.RuntimeToolsConfig.Image.FileStateDir),
	)

	currentProfile := opts.Route.Profile
	if useTaskRoute {
		currentProfile = taskRoute.Profile
	}
	engineOptions := []agent.Option{
		agent.WithLogger(opts.Logger),
		agent.WithLogOptions(opts.LogOptions),
		agent.WithEngineToolsConfig(engineToolsConfig),
		agent.WithSystemPromptCacheControl(systemPromptCacheControl),
		agent.WithGuard(opts.SharedGuard),
		agent.WithSubtaskProfileResolver(taskruntime.SubtaskProfileResolver(d)),
		agent.WithModelProfiles(taskruntime.ModelProfileLister(d, currentProfile)),
		agent.WithRunContext(taskruntime.MemoriesRunContext(memoryStore, audience.Owner(), opts.Logger)),
		toolSearchOption,
		codeModeOption,
	}
	if progress != nil {
		engineOptions = append(engineOptions, agent.WithPlanStepUpdate(progress.PlanStepUpdate))
	}
	engine := agent.New(taskClient, reg, opts.Config, promptSpec, engineOptions...)
	runOpts := agent.RunOptions{
		Model: taskModel,
		Scene: "awareness." + string(opts.Behavior),
		Meta: taskruntime.ApplyObservationMeta(opts.Meta, taskruntime.ObservationMetaIDs{
			TaskID:  opts.TaskRunID,
			TraceID: opts.TaskRunID,
		}),
		DisableContextCompaction: true,
	}
	if progress != nil {
		runCtx = progress.Context(runCtx)
		runOpts.OnStream = progress.OnStream
		runOpts.ReasoningDetails = true
	}
	final, finalCtx, err := engine.Run(runCtx, task, runOpts)
	agentCtx = finalCtx
	if err != nil {
		return "", err
	}

	summary = strings.TrimSpace(outputfmt.FormatFinalOutput(final))
	taskRecordFinished = true
	var extra map[string]any
	if progress != nil {
		extra = progress.Result(final, agentCtx)
	}
	recordErr := recordAwarenessTaskFinish(recordOpts, summary, extra, nil, time.Now().UTC())
	if progress != nil {
		progress.Close(summary, recordErr)
	}
	if recordErr != nil {
		return "", fmt.Errorf("record awareness task finish: %w", recordErr)
	}
	return summary, nil
}

func closeAwarenessTaskClient(logger *slog.Logger, client llm.Client) {
	if client == nil {
		return
	}
	closer, ok := client.(io.Closer)
	if !ok {
		return
	}
	if err := closer.Close(); err != nil && logger != nil {
		logger.Warn("awareness_task_client_close_failed", "error", err.Error())
	}
}

func recordAwarenessTaskStart(opts awarenessTaskOptions, task string, now time.Time) error {
	if opts.TaskStore == nil {
		return nil
	}
	taskID := strings.TrimSpace(opts.TaskRunID)
	if taskID == "" {
		return nil
	}
	startedAt := now.UTC()
	info := daemonruntime.TaskInfo{
		ID:        taskID,
		Status:    daemonruntime.TaskRunning,
		Task:      strings.TrimSpace(task),
		Model:     strings.TrimSpace(opts.Model),
		CreatedAt: startedAt,
		StartedAt: &startedAt,
		TopicID:   daemonruntime.ConsoleAwarenessTopicID,
	}
	if topicID := strings.TrimSpace(opts.TopicID); topicID != "" {
		info.TopicID = topicID
	}
	if opts.TaskTimeout > 0 {
		info.Timeout = opts.TaskTimeout.String()
	}
	trigger := awarenessTaskTrigger(opts)
	if title := strings.TrimSpace(opts.TopicTitle); title != "" {
		// A store with topics names the run's topic as it records the run.
		if store, ok := opts.TaskStore.(topicTitledTaskRecorder); ok {
			return store.UpsertWithTrigger(info, trigger, title)
		}
	}
	return taskdomain.RecordTaskUpsert(opts.TaskStore, info, trigger)
}

// topicTitledTaskRecorder records a task and sets its topic's title, such as the Console store.
type topicTitledTaskRecorder interface {
	UpsertWithTrigger(info daemonruntime.TaskInfo, trigger daemonruntime.TaskTrigger, topicTitle string) error
}

// cronTopicTitle names a TODO item's topic: the item's title, or its default.
func cronTopicTitle(task cronstore.Task) string {
	if title := strings.TrimSpace(task.Title); title != "" {
		return title
	}
	return cronstore.DefaultTaskTitle
}

// extra holds more result fields, such as the plan and activity a live view kept; "final" is
// always the summary.
func recordAwarenessTaskFinish(opts awarenessTaskOptions, summary string, extra map[string]any, runErr error, now time.Time) error {
	if opts.TaskStore == nil {
		return nil
	}
	taskID := strings.TrimSpace(opts.TaskRunID)
	if taskID == "" {
		return nil
	}
	finishedAt := now.UTC()
	trigger := awarenessTaskTrigger(opts)
	return taskdomain.RecordTaskUpdate(opts.TaskStore, taskID, trigger, func(info *daemonruntime.TaskInfo) {
		info.FinishedAt = &finishedAt
		result := make(map[string]any, len(extra)+1)
		for key, value := range extra {
			result[key] = value
		}
		if errors.Is(runErr, cronstore.ErrRunStopped) {
			info.Status = daemonruntime.TaskCanceled
			info.Error = cronstore.ErrRunStopped.Error()
			if len(result) > 0 {
				info.Result = result
			}
			return
		}
		if runErr != nil {
			info.Status = daemonruntime.TaskFailed
			info.Error = depsutil.FormatRuntimeError(runErr)
			if len(result) > 0 {
				info.Result = result
			}
			return
		}
		info.Status = daemonruntime.TaskDone
		info.Error = ""
		result["final"] = map[string]any{
			"output": strings.TrimSpace(summary),
		}
		info.Result = result
	})
}

func awarenessTaskTrigger(opts awarenessTaskOptions) daemonruntime.TaskTrigger {
	behavior := awarenessutil.NormalizeBehavior(string(opts.Behavior))
	trigger := daemonruntime.TaskTrigger{
		Source:  "console",
		Event:   "awareness_" + string(behavior),
		TraceID: strings.TrimSpace(opts.TaskRunID),
	}
	// A TODO item's run says whether its schedule fired it or a person asked for it: the Console
	// raises no notification for a scheduled run (see consolecmd's notification hub).
	if behavior == awarenessutil.BehaviorCron {
		trigger.Ref = daemonruntime.CronRunTriggerRefSchedule
		if opts.CronManual {
			trigger.Ref = daemonruntime.CronRunTriggerRefManual
		}
	}
	return trigger
}

func notifyAwareness(ctx context.Context, notifier Notifier, logger *slog.Logger, message string) {
	if notifier == nil {
		return
	}
	text := strings.TrimSpace(message)
	if text == "" || strings.HasPrefix(text, "ALERT:") {
		return
	}
	if err := notifier.Notify(ctx, text); err != nil && logger != nil {
		logger.Warn("awareness_notify_error", "error", err.Error())
	}
}

type awarenessInspectors struct {
	prompt  *llminspect.PromptInspector
	request *llminspect.RequestInspector
}

func newAwarenessInspectors(opts RunOptions) (*awarenessInspectors, error) {
	out := &awarenessInspectors{}
	if opts.InspectRequest {
		requestInspector, err := llminspect.NewRequestInspector(llminspect.Options{
			Mode:            awarenessInspectMode(opts.Source),
			Task:            "awareness",
			TimestampFormat: "20060102_150405",
		})
		if err != nil {
			return nil, err
		}
		out.request = requestInspector
	}
	if opts.InspectPrompt {
		promptInspector, err := llminspect.NewPromptInspector(llminspect.Options{
			Mode:            awarenessInspectMode(opts.Source),
			Task:            "awareness",
			TimestampFormat: "20060102_150405",
		})
		if err != nil {
			_ = out.Close()
			return nil, err
		}
		out.prompt = promptInspector
	}
	return out, nil
}

func (i *awarenessInspectors) Wrap(client llm.Client, route llmutil.ResolvedRoute) llm.Client {
	if i == nil {
		return client
	}
	return llminspect.WrapClient(client, llminspect.ClientOptions{
		PromptInspector:  i.prompt,
		RequestInspector: i.request,
		APIBase:          route.ClientConfig.Endpoint,
		Model:            strings.TrimSpace(route.ClientConfig.Model),
	})
}

func (i *awarenessInspectors) Close() error {
	if i == nil {
		return nil
	}
	var promptErr, requestErr error
	if i.prompt != nil {
		promptErr = i.prompt.Close()
	}
	if i.request != nil {
		requestErr = i.request.Close()
	}
	return errors.Join(promptErr, requestErr)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func awarenessInspectMode(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	switch source {
	case "", "heartbeat":
		return "awareness"
	default:
		return "awareness_" + source
	}
}
