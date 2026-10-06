package accountdm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/bus/adapters/accountdm"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/livesend"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/internal/personautil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/textsplit"
	"github.com/quailyquaily/mistermorph/internal/textutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

func runLoop(ctx context.Context, d Dependencies, opts Options) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if opts.Transport == nil {
		return fmt.Errorf("%s transport is required", opts.Channel)
	}
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	channel := opts.Channel
	name := string(channel)
	logger = logger.With("channel", name)
	transport := opts.Transport

	daemonStore := opts.TaskStore
	if daemonStore == nil {
		daemonStore, err = daemonruntime.NewTaskViewForTarget(name, opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: d.TaskPersistenceTargets, TasksDir: d.RuntimePaths.TasksDir,
			JournalDir: d.RuntimePaths.JournalDir, RotateMaxBytes: d.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
	}
	bus, err := busruntime.StartInproc(busruntime.BootstrapOptions{MaxInFlight: opts.BusMaxInFlight, Logger: logger, Component: name})
	if err != nil {
		return err
	}
	busOwned := true
	defer func() {
		if busOwned {
			_ = bus.Close()
		}
	}()
	contactsStore := contacts.NewFileStore(d.RuntimePaths.ContactsDir)
	if err := contactsStore.Ensure(context.Background()); err != nil {
		return err
	}
	contactsService := contacts.NewService(contactsStore)
	workspaceStore := workspace.NewStore(d.RuntimePaths.WorkspaceAttachmentsPath)
	inboundAdapter, err := accountdm.NewInboundAdapter(accountdm.InboundAdapterOptions{Channel: channel, Bus: bus, Store: contactsStore})
	if err != nil {
		return err
	}
	receipts := newDeliveryReceipts()
	// A conversation's sends go out one at a time: the platforms do not order concurrent sends.
	var sendLocks sync.Map
	deliveryAdapter, err := accountdm.NewDeliveryAdapter(channel, func(sendCtx context.Context, accountID, peerID, text, replyTo string) error {
		lock, _ := sendLocks.LoadOrStore(accountID+"\n"+peerID, &sync.Mutex{})
		mu := lock.(*sync.Mutex)
		mu.Lock()
		defer mu.Unlock()
		for index, part := range textsplit.Split(text, transport.MaxTextLength()) {
			quote := ""
			if index == 0 {
				quote = replyTo
			}
			if err := transport.SendText(sendCtx, accountID, peerID, part, quote); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	generations, err := runtimecore.BootstrapRuntimeGenerationManager(ctx, d.CommonDependencies, runtimecore.ChannelBootstrapOptions{
		Mode: name, InspectRequest: opts.InspectRequest, InspectPrompt: opts.InspectPrompt,
		AgentConfig: opts.AgentLimits.ToConfig(), EngineToolsConfig: &opts.EngineToolsConfig, Logger: logger,
	})
	if err != nil {
		return err
	}
	defer generations.Close()
	runControl := runtimecontrol.New()
	workersCtx, stopWorkers := context.WithCancel(context.WithoutCancel(ctx))
	sem := make(chan struct{}, opts.MaxConcurrency)
	env := taskEnv{
		channel: channel, bus: bus, receipts: receipts, logger: logger, promptBlocks: opts.PromptBlocks,
		sendFile: transport.SendFile, maxFileBytes: transport.MaxFileBytes(),
	}
	reply := func(replyCtx context.Context, accountID, peerID, text, replyTo, correlation string) error {
		return publish(replyCtx, bus, channel, accountID, peerID, text, replyTo, correlation)
	}

	var stateMu sync.Mutex
	history := make(map[string][]chathistory.ChatHistoryItem)
	stickySkills := make(map[string][]string)
	approvals := newApprovalManager(name, reply, daemonStore, generations, workersCtx, logger)
	var runner *runtimecore.ConversationRunner[string, dmJob]
	runner = runtimecore.NewConversationRunner(workersCtx, sem, 16, func(workerCtx context.Context, conversationKey string, j dmJob) {
		retainGeneration := false
		defer func() {
			if !retainGeneration {
				j.releaseGeneration()
			}
		}()
		bundle := j.runtimeBundle()
		if bundle == nil || bundle.TaskRuntime == nil {
			markTaskFailed(logger, daemonStore, j.TaskID, name+" runtime generation is unavailable", false)
			return
		}
		stateMu.Lock()
		prior := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
		skills := append([]string(nil), stickySkills[conversationKey]...)
		stateMu.Unlock()
		currentVersion := runner.CurrentVersion(conversationKey)
		if j.Version != currentVersion {
			prior = nil
		}
		if err := runtimecore.MarkTaskRunning(daemonStore, j.TaskID); err != nil {
			logger.Error("task_state_write_error", "task_id", j.TaskID, "status", daemonruntime.TaskRunning, "error", err.Error())
			return
		}
		lease, err := runControl.StartLease(workerCtx, opts.TaskTimeout, runtimecontrol.ActiveRun{
			Runtime: name, ConversationKey: conversationKey, TopicID: j.PeerID, TaskID: j.TaskID, RunID: j.TaskID,
		})
		if err != nil {
			markTaskFailed(logger, daemonStore, j.TaskID, err.Error(), false)
			return
		}
		runCtx := taskruntime.WithContextCompactionNotification(lease.Context, logger, func(notifyCtx context.Context, event agent.Event, text string) error {
			return reply(notifyCtx, j.AccountID, j.PeerID, text, "", fmt.Sprintf("context-compaction:%s:%d", j.TaskID, event.Step))
		})
		stopTyping := transport.Typing(runCtx, j.AccountID, j.PeerID)
		result, runErr := runTask(runCtx, bundle.TaskRuntime, env, j, prior, skills, lease.SteerQueue)
		stopTyping()
		userStopped := lease.UserStopped()
		lease.Finish()
		if runErr != nil {
			displayErr := depsutil.FormatRuntimeError(runErr)
			if userStopped {
				displayErr = "stopped by user"
			}
			markTaskFailed(logger, daemonStore, j.TaskID, displayErr, userStopped)
			logger.Warn("task_error", "message_id", j.MessageID, "error", displayErr)
			if !userStopped && workerCtx.Err() == nil {
				_ = publishAndWait(workerCtx, bus, receipts, channel, j.AccountID, j.PeerID, "error: "+displayErr, "", "error:"+j.TaskID)
			}
			return
		}
		if pendingID, ok := runtimecore.PendingApprovalID(result.Final); ok {
			pendingAt := time.Now().UTC()
			if err := daemonStore.Update(j.TaskID, func(info *daemonruntime.TaskInfo) {
				info.Status = daemonruntime.TaskPending
				info.PendingAt = &pendingAt
				info.ApprovalRequestID = pendingID
				info.Result = map[string]any{"source": name, "final": result.Final}
			}); err != nil {
				logger.Error("task_state_write_error", "task_id", j.TaskID, "status", daemonruntime.TaskPending, "error", err.Error())
				return
			}
			if err := approvals.register(pendingID, j); err != nil {
				applied, stateErr := runtimecore.FailPendingApprovalTask(daemonStore, j.TaskID, pendingID, runtimecore.ApprovalRegistrationFailedTaskError)
				if stateErr != nil {
					err = errors.Join(err, stateErr)
				}
				logger.Error("approval_register_error", "approval_request_id", pendingID, "task_id", j.TaskID, "task_failed", applied, "error", err.Error())
				return
			}
			if err := approvals.notify(context.Background(), pendingID, j); err != nil {
				logger.Warn("approval_notify_error", "approval_request_id", pendingID, "error", err.Error())
			}
			retainGeneration = true
			return
		}
		output := strings.TrimSpace(outputfmt.FormatFinalOutput(result.Final))
		if output != "" {
			if err := workerCtx.Err(); err != nil {
				markTaskFailed(logger, daemonStore, j.TaskID, err.Error(), true)
				return
			}
			if err := publishAndWait(workerCtx, bus, receipts, channel, j.AccountID, j.PeerID, output, j.MessageID, "message:"+j.TaskID); err != nil {
				markTaskFailed(logger, daemonStore, j.TaskID, "send "+name+" response: "+err.Error(), false)
				return
			}
		}
		if err := runtimecore.MarkTaskDone(daemonStore, j.TaskID, output); err != nil {
			logger.Error("task_state_write_error", "task_id", j.TaskID, "status", daemonruntime.TaskDone, "error", err.Error())
			return
		}
		stateMu.Lock()
		if runner.CurrentVersion(conversationKey) != currentVersion {
			history[conversationKey] = nil
			stickySkills[conversationKey] = nil
		} else if !chatcommands.IsContextCompactCommand(j.Text) {
			if len(result.LoadedSkills) > 0 {
				stickySkills[conversationKey] = capSkills(result.LoadedSkills)
			}
			history[conversationKey] = trimHistory(append(history[conversationKey], turnHistory(j, result, output, time.Now().UTC())...))
		}
		stateMu.Unlock()
	}, runtimecore.ConversationRunnerOptions[string, dmJob]{
		Logger: logger,
		OnDrop: func(_ string, j dmJob) {
			markTaskCanceled(logger, daemonStore, j.TaskID, name)
			j.releaseGeneration()
		},
		OnPanic: func(conversationKey string, j dmJob) {
			defer j.releaseGeneration()
			runControl.Finish(name, conversationKey, j.TaskID)
			markTaskFailed(logger, daemonStore, j.TaskID, "conversation worker panicked", false)
		},
	})
	approvals.runner = runner

	var daemonServer *http.Server
	var stopDaemon context.CancelFunc
	if opts.ServerListen != "" {
		daemonCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		stopDaemon = cancel
		daemonServer, err = daemonruntime.StartServer(daemonCtx, logger, daemonruntime.ServerOptions{
			Listen: opts.ServerListen,
			Routes: daemonruntime.RoutesOptions{
				Mode: name, RuntimePaths: d.RuntimePaths, AuthToken: opts.ServerAuthToken,
				AgentNameFunc: func() string { return personautil.LoadAgentName(d.RuntimePaths.StateDir) },
				TaskTopic:     daemonruntime.TaskTopicRoutes{TaskReader: daemonStore},
				Approvals: daemonruntime.ApprovalRoutes{
					List: approvals.listApprovals, Get: approvals.getApproval,
					Approve: approvals.approve, Deny: approvals.deny,
				},
				Overview: func(context.Context) (map[string]any, error) {
					return map[string]any{
						"channel":      transport.Overview(),
						"poke_enabled": opts.Poke != nil, "cron_run_enabled": opts.CronRun != nil,
					}, nil
				},
				Poke: opts.Poke, CronRun: opts.CronRun,
				AgentSettingsEnabled: true, AgentSettingsOwner: d.AgentSettingsOwner, AgentSettingsReader: d.AgentSettingsReader, HealthEnabled: true,
			},
		})
		if err != nil {
			cancel()
			stopDaemon = nil
			daemonServer = nil
			logger.Warn("daemon_server_start_error", "addr", opts.ServerListen, "error", err.Error())
		}
	}
	defer func() {
		if daemonServer != nil {
			_ = daemonServer.Shutdown(context.Background())
		}
		if stopDaemon != nil {
			stopDaemon()
		}
		stopWorkers()
		_ = bus.Close()
		runner.WaitClosed()
		approvals.close()
	}()
	busOwned = false
	generations.Start(ctx)

	enqueueInbound := func(handlerCtx context.Context, message busruntime.BusMessage) error {
		inbound, err := accountdm.InboundMessageFromBusMessage(message)
		if err != nil {
			return err
		}
		in := Inbound{
			AccountID: inbound.AccountID, PeerID: inbound.PeerID, MessageID: inbound.MessageID, SentAt: inbound.SentAt,
			DisplayName: inbound.DisplayName, Text: inbound.Text, ReplyToMessageID: inbound.ReplyToMessageID,
		}
		imagePaths := busruntime.ImagePathsFromAttachments(inbound.ImageAttachments)
		text := strings.TrimSpace(in.Text)
		conversationKey := message.ConversationKey
		answer := func(body, correlation string) error {
			return reply(handlerCtx, in.AccountID, in.PeerID, body, in.MessageID, correlation)
		}
		stateMu.Lock()
		currentSkills := append([]string(nil), stickySkills[conversationKey]...)
		stateMu.Unlock()
		if commandName(text) == "/stop" {
			result := runControl.Stop(name, conversationKey, "/stop")
			return answer(runtimecontrol.StopFeedback(result.Found), "stop:"+in.MessageID)
		}
		if approvalID, approved, ok := parseApprovalCommand(text); ok {
			_, _, decisionErr := approvals.apply(handlerCtx, approvalID, approved, name+"_user:"+in.PeerID, func(j dmJob) bool {
				return j.ConversationKey == conversationKey
			})
			response := approvalResultText(approved)
			if decisionErr != nil {
				response = "Approval failed: " + strings.TrimSpace(decisionErr.Error())
			}
			return answer(response, "approval-result:"+approvalID)
		}
		compactOnly := chatcommands.IsContextCompactCommand(text)
		if output, handled := handleCommand(handlerCtx, d, workspaceStore, conversationKey, in, name, currentSkills, func(resetCtx context.Context) error {
			runControl.Stop(name, conversationKey, "/reset")
			generation, captureErr := generations.Capture()
			if captureErr != nil {
				return captureErr
			}
			bundle := generation.Bundle()
			if bundle == nil || bundle.TaskRuntime == nil {
				generation.Release()
				return fmt.Errorf("%s runtime generation is unavailable", name)
			}
			resetErr := bundle.TaskRuntime.ResetContextHistory(resetCtx, conversationKey)
			generation.Release()
			if resetErr != nil {
				return resetErr
			}
			stateMu.Lock()
			delete(history, conversationKey)
			delete(stickySkills, conversationKey)
			runner.IncrementVersion(conversationKey)
			stateMu.Unlock()
			return nil
		}); handled {
			if output == "" {
				return nil
			}
			return answer(output, "command:"+in.MessageID)
		}
		if !compactOnly {
			if result := runControl.Steer(name, conversationKey, text); result.Found {
				return answer(runtimecontrol.SteerFeedback(result.Found, result.Queued), "steer:"+in.MessageID)
			}
		}
		// These channels have no reactions, so an emoji reply is sent as a message.
		lightweightDecided := false
		if !compactOnly && runtimecore.LightweightPrecheckApplies(text, len(imagePaths) > 0) {
			if lease, captureErr := generations.Capture(); captureErr == nil {
				stateMu.Lock()
				historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
				stateMu.Unlock()
				result, emoji := runtimecore.RunLightweightPrecheck(handlerCtx, lease.Bundle(), runtimecore.LightweightPrecheckRequest{
					Scene:          name + ".lightweight_decision",
					PersonaDir:     d.RuntimePaths.PersonaDir,
					CurrentMessage: map[string]any{"chat_type": "private", "user_id": in.PeerID, "display_name": in.DisplayName, "text": text},
					History:        chathistory.BuildMessages(string(channel), historySnapshot),
					Logger:         logger,
					Deliver: func(_ context.Context, emoji string) error {
						return answer(emoji, "lightweight:"+in.MessageID)
					},
				})
				lease.Release()
				switch result {
				case runtimecore.PrecheckHandled:
					j := dmJob{
						Channel: channel, ConversationKey: conversationKey, AccountID: in.AccountID, PeerID: in.PeerID,
						MessageID: in.MessageID, ReplyToMessageID: in.ReplyToMessageID, DisplayName: in.DisplayName, Text: text, SentAt: in.SentAt,
					}
					now := time.Now().UTC()
					stateMu.Lock()
					history[conversationKey] = trimHistory(append(history[conversationKey], inboundHistoryItem(j), outboundHistoryItem(j, emoji, now)))
					stateMu.Unlock()
					return nil
				case runtimecore.PrecheckText:
					lightweightDecided = true
				}
			}
		}
		taskID := daemonruntime.BuildTaskID(taskIDPrefix(channel), in.AccountID+":"+in.PeerID, in.MessageID)
		generation, err := generations.Capture()
		if err != nil {
			return err
		}
		bundle := generation.Bundle()
		if bundle == nil || bundle.TaskRuntime == nil {
			generation.Release()
			return fmt.Errorf("%s runtime generation is unavailable", name)
		}
		resolution, err := workspace.Resolve(workspaceStore, conversationKey, d.DefaultWorkspaceDir)
		if err != nil {
			generation.Release()
			return err
		}
		route, err := bundle.TaskRuntime.ResolveTaskRouteForRun(llmstats.WithRunID(handlerCtx, taskID), text)
		if err != nil {
			generation.Release()
			return err
		}
		buildJob := func(version uint64) dmJob {
			admittedRoute := route
			return dmJob{
				TaskID: taskID, Channel: channel, ConversationKey: conversationKey, AccountID: in.AccountID, PeerID: in.PeerID,
				MessageID: in.MessageID, ReplyToMessageID: in.ReplyToMessageID, DisplayName: in.DisplayName, Text: text,
				ImagePaths: imagePaths, FileCacheDir: opts.FileCacheDir,
				WorkspaceDir: resolution.WorkspaceDir, Route: &admittedRoute, SentAt: in.SentAt, Version: version, Generation: generation,
				LightweightDecided: lightweightDecided,
			}
		}
		createdAt := in.SentAt.UTC()
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		if err := taskdomain.RecordTaskUpsert(daemonStore, daemonruntime.TaskInfo{
			ID: taskID, Status: daemonruntime.TaskQueued, Task: textutil.TruncateRunes(text, 2000), Model: route.ClientConfig.Model,
			Timeout: opts.TaskTimeout.String(), CreatedAt: createdAt, Conversation: taskConversation(buildJob(0), in.AccountID),
			Result: map[string]any{"source": name, name + "_peer_id": in.PeerID, name + "_message_id": in.MessageID},
		}, daemonruntime.TaskTrigger{Source: name, Event: "poll_message", Ref: in.MessageID}); err != nil {
			generation.Release()
			return err
		}
		if err := runner.Enqueue(handlerCtx, conversationKey, buildJob); err != nil {
			generation.Release()
			markTaskFailed(logger, daemonStore, taskID, err.Error(), taskdomain.EndedByCancellation(handlerCtx, err))
			return err
		}
		logger.Info("task_enqueued", "message_id", in.MessageID, "conversation_key", conversationKey, "text_len", len(text))
		return nil
	}

	busHandler := func(handlerCtx context.Context, message busruntime.BusMessage) error {
		if message.Channel != channel {
			return fmt.Errorf("unsupported channel: %s", message.Channel)
		}
		switch message.Direction {
		case busruntime.DirectionInbound:
			if err := contactsService.ObserveInboundBusMessage(context.Background(), message, time.Now().UTC()); err != nil {
				logger.Warn("contacts_observe_bus_error", "error", err.Error())
			}
			return enqueueInbound(handlerCtx, message)
		case busruntime.DirectionOutbound:
			err := deliveryAdapter.Deliver(handlerCtx, message)
			receipts.complete(message.ID, err)
			return err
		default:
			return fmt.Errorf("unsupported direction: %s", message.Direction)
		}
	}
	for _, topic := range busruntime.AllTopics() {
		if err := bus.Subscribe(topic, busHandler); err != nil {
			return err
		}
	}

	peers := newPeerBook(d.RuntimePaths.StateDir, channel)
	unregister := livesend.Register(name, &liveSender{
		channel: channel, transport: transport, bus: bus, receipts: receipts, peers: peers,
	})
	defer unregister()

	logger.Info("runtime_start", "task_timeout", opts.TaskTimeout.String(), "max_concurrency", opts.MaxConcurrency)
	err = transport.Run(ctx, func(messageCtx context.Context, in Inbound) error {
		peers.add(in.AccountID, in.PeerID)
		if in.Unsupported {
			first, seenErr := inboundAdapter.FirstSeen(messageCtx, in.AccountID, in.PeerID, in.MessageID)
			if seenErr != nil || !first {
				return seenErr
			}
			return transport.SendText(messageCtx, in.AccountID, in.PeerID, unsupportedNotice, in.MessageID)
		}
		var images []busruntime.ImageAttachment
		if len(in.Media) > 0 {
			// Skip a replay before downloading its media again; the inbox still dedupes below.
			seen, seenErr := inboundAdapter.Seen(messageCtx, in.AccountID, in.MessageID)
			if seenErr != nil {
				return seenErr
			}
			if seen {
				logger.Debug("message_deduped", "message_id", in.MessageID)
				return nil
			}
			saved := saveInboundMedia(messageCtx, channel, opts.FileCacheDir, in, logger)
			in.Text = mediaText(in.Text, saved, in)
			images = saved.Images
		}
		if strings.TrimSpace(in.Text) == "" {
			return nil
		}
		accepted, publishErr := inboundAdapter.HandleInboundMessage(messageCtx, accountdm.InboundMessage{
			AccountID: in.AccountID, PeerID: in.PeerID, MessageID: in.MessageID, SentAt: in.SentAt,
			DisplayName: in.DisplayName, Text: in.Text, ReplyToMessageID: in.ReplyToMessageID, ImageAttachments: images,
		})
		if publishErr != nil {
			logger.Warn("bus_publish_error", "message_id", in.MessageID, "error", publishErr.Error())
			return publishErr
		}
		if !accepted {
			logger.Debug("message_deduped", "message_id", in.MessageID)
		}
		return nil
	})
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil {
		logger.Info("runtime_stop", "reason", "context_canceled")
		return nil
	}
	return err
}

func taskIDPrefix(channel busruntime.Channel) string {
	if channel == busruntime.ChannelWeChat {
		return "wx"
	}
	return "wa"
}

func markTaskFailed(logger *slog.Logger, store daemonruntime.TaskUpdater, taskID, message string, stopped bool) {
	if err := runtimecore.MarkTaskFailed(store, taskID, strings.TrimSpace(message), stopped); err != nil {
		logger.Error("task_state_write_error", "task_id", taskID, "status", daemonruntime.TaskFailed, "error", err.Error())
	}
}

func markTaskCanceled(logger *slog.Logger, store daemonruntime.TaskUpdater, taskID, channel string) {
	if store == nil || strings.TrimSpace(taskID) == "" {
		return
	}
	finishedAt := time.Now().UTC()
	if err := store.Update(taskID, func(info *daemonruntime.TaskInfo) {
		if info != nil && (info.Status == daemonruntime.TaskQueued || info.Status == daemonruntime.TaskRunning) {
			info.Status = daemonruntime.TaskCanceled
			info.Error = channel + " runtime closed"
			info.FinishedAt = &finishedAt
		}
	}); err != nil {
		logger.Error("task_state_write_error", "task_id", taskID, "status", daemonruntime.TaskCanceled, "error", err.Error())
	}
}
