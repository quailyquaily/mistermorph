package discord

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentpair"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imagehistory"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/chatinfo"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/personautil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/textutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
	discordtools "github.com/quailyquaily/mistermorph/tools/discord"
)

func runDiscordLoop(ctx context.Context, d Dependencies, opts RunOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	allowlist, err := newDiscordAllowlist(opts.AllowedGuildIDs, opts.AllowedChannelIDs, opts.AllowedUserIDs)
	if err != nil {
		return err
	}
	var connected atomic.Bool
	onConnectionChange := func(value bool) {
		connected.Store(value)
		if opts.OnConnectionChange != nil {
			opts.OnConnectionChange(value)
		}
		if value {
			logger.Info("discord_gateway_connected")
		} else {
			logger.Warn("discord_gateway_disconnected")
		}
	}
	api, err := discordRESTClient(opts)
	if err != nil {
		return err
	}
	bot, err := api.Me(ctx)
	if err != nil {
		if discordapi.IsUnauthorized(err) {
			return fmt.Errorf("discord rejected the bot token: check discord.bot_token or MISTER_MORPH_DISCORD_BOT_TOKEN")
		}
		return fmt.Errorf("load discord bot profile: %w", err)
	}
	botID, err := discordbus.NormalizeSnowflake("bot user id", bot.ID)
	if err != nil {
		return fmt.Errorf("load discord bot profile: %w", err)
	}
	botName := firstNonEmpty(bot.DisplayName(), bot.Username)
	logger.Info("discord_profile_loaded", "user_id", botID, "username", bot.Username)
	gateway, err := discordGatewayClient(ctx, api, opts, logger, onConnectionChange)
	if err != nil {
		return err
	}

	daemonStore := opts.TaskStore
	if daemonStore == nil {
		daemonStore, err = daemonruntime.NewTaskViewForTarget("discord", opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: d.TaskPersistenceTargets, TasksDir: d.RuntimePaths.TasksDir,
			JournalDir: d.RuntimePaths.JournalDir, RotateMaxBytes: d.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
	}
	bus, err := busruntime.StartInproc(busruntime.BootstrapOptions{MaxInFlight: opts.BusMaxInFlight, Logger: logger, Component: "discord"})
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
	avatarRefresher, err := contacts.NewContactAvatarRefresher(ctx, contactsStore, logger.With("channel", "discord"))
	if err != nil {
		return err
	}
	defer avatarRefresher.Close()
	chatInfoStore := chatinfo.NewStore(d.RuntimePaths.ContactsDir)
	var savedChatProfiles sync.Map
	adminValues := []string(nil)
	if d.AgentSettingsReader != nil {
		adminValues = d.AgentSettingsReader.GetStringSlice("admins")
	}
	admins, err := agentpair.ParseAdmins(adminValues)
	if err != nil {
		return err
	}
	selfPeer := agentpair.Peer{ID: "discord_user:" + botID, Contact: contacts.Contact{
		ContactID: "discord_user:" + botID, Kind: contacts.KindAgent, Channel: contacts.ChannelDiscord,
		ContactNickname: botName, DiscordUserID: botID,
	}}
	pairManager, err := agentpair.New(agentpair.Options{
		Context: ctx, Self: selfPeer, Admins: admins, Contacts: contactsService,
		JournalDir: d.RuntimePaths.JournalDir, JournalRotateMaxBytes: d.TaskRotateMaxBytes, Logger: logger,
		Send: func(sendCtx context.Context, target agentpair.Peer, body string) error {
			userID, targetErr := discordPairSendUserID(target)
			if targetErr != nil {
				return targetErr
			}
			channelID := strings.TrimSpace(target.Contact.DiscordDMChannelID)
			if channelID == "" {
				dm, dmErr := api.CreateDM(sendCtx, userID)
				if dmErr != nil {
					return dmErr
				}
				channelID = dm.ID
			}
			_, sendErr := sendDiscordText(sendCtx, api, channelID, body, "")
			return sendErr
		},
	})
	if err != nil {
		return err
	}
	workspaceStore := workspace.NewStore(d.RuntimePaths.WorkspaceAttachmentsPath)
	inboundAdapter, err := discordbus.NewInboundAdapter(discordbus.InboundAdapterOptions{Bus: bus, Store: contactsStore})
	if err != nil {
		return err
	}
	receipts := newDiscordDeliveryReceipts()
	interactions := newDiscordInteractionReplies(api, logger)
	deliveryAdapter, err := discordbus.NewDeliveryAdapter(discordbus.DeliveryAdapterOptions{
		SendText: func(sendCtx context.Context, channelID, text string, sendOpts discordbus.SendTextOptions) error {
			return interactions.send(sendCtx, channelID, text, sendOpts.ReplyToMessageID)
		},
	})
	if err != nil {
		return err
	}
	var untriggered *runtimecore.UntriggeredRecorder
	if opts.RecordUntriggered {
		untriggered, err = runtimecore.NewUntriggeredRecorder(d.RuntimePaths.JournalDir, d.TaskRotateMaxBytes)
		if err != nil {
			return err
		}
		defer func() { _ = untriggered.Close() }()
	}

	generations, err := runtimecore.BootstrapRuntimeGenerationManager(ctx, d.CommonDependencies, runtimecore.ChannelBootstrapOptions{
		Mode: "discord", InspectRequest: opts.InspectRequest, InspectPrompt: opts.InspectPrompt,
		AgentConfig: opts.AgentLimits.ToConfig(), EngineToolsConfig: &opts.EngineToolsConfig, Logger: logger,
	})
	if err != nil {
		return err
	}
	defer generations.Close()
	runControl := runtimecontrol.New()
	workersCtx, stopWorkers := context.WithCancel(context.WithoutCancel(ctx))
	sem := make(chan struct{}, opts.MaxConcurrency)
	taskEnv := discordTaskEnv{api: api, bus: bus, receipts: receipts, logger: logger, botID: botID, botName: botName, fileLimit: discordtools.DefaultFileMaxBytes}

	var stateMu sync.Mutex
	history := make(map[string][]chathistory.ChatHistoryItem)
	stickySkills := make(map[string][]string)
	appendHistory := func(conversationKey string, items ...chathistory.ChatHistoryItem) {
		stateMu.Lock()
		history[conversationKey] = trimDiscordHistory(append(history[conversationKey], items...))
		stateMu.Unlock()
	}
	approvals := newDiscordApprovalManager(api, bus, daemonStore, generations, workersCtx, logger)
	var runner *runtimecore.ConversationRunner[string, discordJob]
	runner = runtimecore.NewConversationRunner(workersCtx, sem, 16, func(workerCtx context.Context, conversationKey string, job discordJob) {
		retainGeneration := false
		defer func() {
			if !retainGeneration {
				job.releaseGeneration()
			}
		}()
		// A slash command whose run sent nothing (a reaction, an approval request) leaves its
		// placeholder; remove it.
		defer interactions.finish(context.WithoutCancel(workerCtx), job.MessageID)
		bundle := job.runtimeBundle()
		if bundle == nil || bundle.TaskRuntime == nil {
			markDiscordTaskFailed(logger, daemonStore, job.TaskID, "discord runtime generation is unavailable", false)
			return
		}
		stateMu.Lock()
		prior := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
		skills := append([]string(nil), stickySkills[conversationKey]...)
		stateMu.Unlock()
		currentVersion := runner.CurrentVersion(conversationKey)
		if job.Version != currentVersion {
			prior = nil
		}
		if err := runtimecore.MarkTaskRunning(daemonStore, job.TaskID); err != nil {
			logger.Error("discord_task_state_write_error", "task_id", job.TaskID, "status", daemonruntime.TaskRunning, "error", err.Error())
			return
		}
		lease, err := runControl.StartLease(workerCtx, opts.TaskTimeout, runtimecontrol.ActiveRun{
			Runtime: "discord", ConversationKey: conversationKey, TopicID: job.ChannelID, TaskID: job.TaskID, RunID: job.TaskID,
		})
		if err != nil {
			markDiscordTaskFailed(logger, daemonStore, job.TaskID, err.Error(), false)
			return
		}
		runCtx := taskruntime.WithContextCompactionNotification(lease.Context, logger, func(notifyCtx context.Context, event agent.Event, text string) error {
			return publishDiscordBusOutbound(notifyCtx, bus, job.ChannelID, text, job.replyTarget(), fmt.Sprintf("discord:context-compaction:%s:%d", job.TaskID, event.Step))
		})
		stopTyping := keepTyping(runCtx, api, job.ChannelID)
		result, runErr := runDiscordTask(runCtx, bundle.TaskRuntime, taskEnv, job, prior, skills, lease.SteerQueue)
		stopTyping()
		userStopped := lease.UserStopped()
		lease.Finish()
		if runErr != nil {
			displayErr := depsutil.FormatRuntimeError(runErr)
			if userStopped {
				displayErr = "stopped by user"
			}
			markDiscordTaskFailed(logger, daemonStore, job.TaskID, displayErr, userStopped)
			logger.Warn("discord_task_error", "channel_id", job.ChannelID, "message_id", job.MessageID, "error", displayErr)
			if !userStopped && workerCtx.Err() == nil {
				_, _ = publishDiscordBusOutboundAndWait(workerCtx, bus, receipts, job.ChannelID, "error: "+displayErr, job.replyTarget(), "discord:error:"+job.TaskID)
			}
			return
		}
		final := result.Final
		if pendingID, ok := runtimecore.PendingApprovalID(final); ok {
			pendingAt := time.Now().UTC()
			if err := daemonStore.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
				info.Status = daemonruntime.TaskPending
				info.PendingAt = &pendingAt
				info.ApprovalRequestID = pendingID
				info.Result = map[string]any{"source": "discord", "final": final}
			}); err != nil {
				logger.Error("discord_task_state_write_error", "task_id", job.TaskID, "status", daemonruntime.TaskPending, "error", err.Error())
				return
			}
			if err := approvals.register(pendingID, job); err != nil {
				applied, stateErr := runtimecore.FailPendingApprovalTask(daemonStore, job.TaskID, pendingID, runtimecore.ApprovalRegistrationFailedTaskError)
				if stateErr != nil {
					err = errors.Join(err, stateErr)
				}
				logger.Error("discord_approval_register_error", "approval_request_id", pendingID, "task_id", job.TaskID, "task_failed", applied, "error", err.Error())
				return
			}
			if err := approvals.notify(context.Background(), pendingID, job); err != nil {
				logger.Warn("discord_approval_notify_error", "approval_request_id", pendingID, "channel_id", job.ChannelID, "error", err.Error())
			}
			retainGeneration = true
			return
		}
		output := strings.TrimSpace(outputfmt.FormatFinalOutput(final))
		if output != "" {
			if err := workerCtx.Err(); err != nil {
				markDiscordTaskFailed(logger, daemonStore, job.TaskID, err.Error(), true)
				return
			}
			if _, err := publishDiscordBusOutboundAndWait(workerCtx, bus, receipts, job.ChannelID, output, job.replyTarget(), "discord:message:"+job.TaskID); err != nil {
				markDiscordTaskFailed(logger, daemonStore, job.TaskID, "send discord response: "+err.Error(), false)
				return
			}
		}
		if err := runtimecore.MarkTaskDone(daemonStore, job.TaskID, output); err != nil {
			logger.Error("discord_task_state_write_error", "task_id", job.TaskID, "status", daemonruntime.TaskDone, "error", err.Error())
			return
		}
		stateMu.Lock()
		latestVersion := runner.CurrentVersion(conversationKey)
		if latestVersion != currentVersion {
			history[conversationKey] = nil
			stickySkills[conversationKey] = nil
		} else if !chatcommands.IsContextCompactCommand(job.Text) {
			if len(result.LoadedSkills) > 0 {
				stickySkills[conversationKey] = capDiscordSkills(result.LoadedSkills)
			}
			turn := discordTurnHistory(job, botName, result, output, time.Now().UTC())
			history[conversationKey] = trimDiscordHistory(append(history[conversationKey], turn...))
		}
		stateMu.Unlock()
	}, runtimecore.ConversationRunnerOptions[string, discordJob]{
		Logger: logger,
		OnDrop: func(_ string, job discordJob) {
			markDiscordTaskCanceled(logger, daemonStore, job.TaskID)
			job.releaseGeneration()
		},
		OnPanic: func(conversationKey string, job discordJob) {
			defer job.releaseGeneration()
			runControl.Finish("discord", conversationKey, job.TaskID)
			markDiscordTaskFailed(logger, daemonStore, job.TaskID, "conversation worker panicked", false)
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
				Mode: "discord", RuntimePaths: d.RuntimePaths, AuthToken: opts.ServerAuthToken,
				AgentNameFunc: func() string {
					if name := personautil.LoadAgentName(d.RuntimePaths.StateDir); name != "" {
						return name
					}
					return botName
				},
				AgentAvatarURL: bot.AvatarURL(),
				TaskTopic:      daemonruntime.TaskTopicRoutes{TaskReader: daemonStore},
				Approvals: daemonruntime.ApprovalRoutes{
					List: approvals.listApprovals, Get: approvals.getApproval,
					Approve: approvals.approve, Deny: approvals.deny,
				},
				Overview: func(context.Context) (map[string]any, error) {
					return map[string]any{
						"channel":      discordChannelOverview(connected.Load()),
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
			logger.Warn("discord_daemon_server_start_error", "addr", opts.ServerListen, "error", err.Error())
		}
	}
	ingressQueue := newKeyedQueue()
	defer func() {
		if daemonServer != nil {
			_ = daemonServer.Shutdown(context.Background())
		}
		if stopDaemon != nil {
			stopDaemon()
		}
		ingressQueue.wait()
		stopWorkers()
		_ = bus.Close()
		runner.WaitClosed()
		approvals.close()
	}()
	busOwned = false
	generations.Start(ctx)

	ingress := newDiscordIngress(api, botID, opts.FileCacheDir, logger)
	ingress.downloadUnaddressed = opts.GroupTriggerMode != groupTriggerStrict
	isPairedAgent := func(lookupCtx context.Context, inbound discordbus.InboundMessage) bool {
		paired, lookupErr := pairManager.IsPaired(lookupCtx, discordInboundAgentPeer(inbound))
		if lookupErr != nil {
			logger.Warn("discord_agent_pair_lookup_failed", "channel_id", inbound.ChannelID, "user_id", inbound.UserID, "error", lookupErr.Error())
		}
		return paired
	}
	ingress.authorize = func(messageCtx context.Context, inbound discordbus.InboundMessage, channel discordapi.Channel) (bool, error) {
		if inbound.ChatType == discordbus.ChatTypeGroup {
			allowed := allowlist.serverAllowed(inbound.GuildID, channel)
			if !allowed {
				logger.Debug("discord_unauthorized_channel", "guild_id", inbound.GuildID, "channel_id", inbound.ChannelID, "message_id", inbound.MessageID)
			}
			return allowed, nil
		}
		if !inbound.FromIsAgent && discordBypassesAllowlist(inbound.Text) {
			return true, nil
		}
		if agentpair.IsControlMessage(inbound.Text) {
			return true, nil
		}
		allowed := allowlist.dmAllowed(inbound.UserID, inbound.FromIsAgent, false) || isPairedAgent(messageCtx, inbound)
		if !allowed {
			logger.Debug("discord_unauthorized_user", "channel_id", inbound.ChannelID, "user_id", inbound.UserID, "from_is_agent", inbound.FromIsAgent)
		}
		return allowed, nil
	}
	triggerOptions := func(bundle *runtimecore.ChannelRuntimeBundle) discordTriggerOptions {
		timeout := bundle.AddressingRoute.ClientConfig.RequestTimeout
		if timeout <= 0 {
			timeout = opts.RequestTimeout
		}
		return discordTriggerOptions{
			Mode: opts.GroupTriggerMode, ConfidenceThreshold: opts.AddressingConfidenceThreshold, InterjectThreshold: opts.AddressingInterjectThreshold,
			Timeout: timeout, Client: bundle.AddressingClient, Model: bundle.AddressingModel, PersonaDir: d.RuntimePaths.PersonaDir,
		}
	}
	recordUntriggered := func(inbound discordbus.InboundMessage) {
		if untriggered == nil {
			return
		}
		if err := untriggered.Record(runtimecore.UntriggeredMessage{
			Channel: string(busruntime.ChannelDiscord), ConversationKey: "discord:" + inbound.ChannelID, MessageID: inbound.MessageID,
			SenderID: inbound.UserID, SentAt: inbound.SentAt, Text: inbound.Text, HasAttachment: len(inbound.ImageAttachments) > 0,
		}); err != nil {
			logger.Error("discord_untriggered_journal_append_error", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "error", err.Error())
		}
	}

	enqueueInbound := func(handlerCtx context.Context, message busruntime.BusMessage) error {
		inbound, err := discordbus.InboundMessageFromBusMessage(message)
		if err != nil {
			return err
		}
		text := strings.TrimSpace(inbound.Text)
		conversationKey := message.ConversationKey
		isGroup := inbound.ChatType == discordbus.ChatTypeGroup
		addressed := discordAddressed(inbound, botID)
		fromInteraction := interactions.known(inbound.MessageID)
		replyTo := discordInboundReplyTarget(inbound, fromInteraction)
		// A slash command gets an answer or a run; otherwise its placeholder is removed. A reply
		// fills the placeholder, so it must not be removed after one was published.
		answered := false
		defer func() {
			if fromInteraction && !answered {
				interactions.finish(context.WithoutCancel(handlerCtx), inbound.MessageID)
			}
		}()
		stateMu.Lock()
		currentSkills := append([]string(nil), stickySkills[conversationKey]...)
		stateMu.Unlock()
		// In servers, a command counts only when it mentions the bot, so several bots in one channel
		// do not all answer it.
		commandsAllowed := !isGroup || addressed
		compactOnly := commandsAllowed && chatcommands.IsContextCompactCommand(text)
		if commandsAllowed {
			if discordCommandName(text) == "/stop" {
				result := runControl.Stop("discord", conversationKey, "/stop")
				answered = true
				return publishDiscordBusOutbound(handlerCtx, bus, inbound.ChannelID, runtimecontrol.StopFeedback(result.Found), replyTo, "discord:stop:"+inbound.MessageID)
			}
			if approvalID, approved, ok := parseDiscordApprovalCommand(text); ok {
				_, _, decisionErr := approvals.apply(handlerCtx, approvalID, approved, "discord:"+inbound.UserID, func(job discordJob) bool {
					return job.ChannelID == inbound.ChannelID
				})
				response := discordApprovalResultText(approved)
				if decisionErr != nil {
					response = "Approval failed: " + strings.TrimSpace(decisionErr.Error())
					logger.Warn("discord_approval_decision_error", "approval_request_id", approvalID, "channel_id", inbound.ChannelID, "user_id", inbound.UserID, "error", decisionErr.Error())
				} else {
					approvals.settleMessage(handlerCtx, approvalID, approved, inbound.UserID, nil)
				}
				answered = true
				return publishDiscordBusOutbound(handlerCtx, bus, inbound.ChannelID, response, replyTo, "discord:approval-result:"+approvalID)
			}
			handled, replied, commandErr := maybeHandleDiscordCommand(handlerCtx, d, bus, workspaceStore, conversationKey, inbound, replyTo, currentSkills, func(resetCtx context.Context) error {
				runControl.Stop("discord", conversationKey, "/reset")
				generation, captureErr := generations.Capture()
				if captureErr != nil {
					return captureErr
				}
				bundle := generation.Bundle()
				if bundle == nil || bundle.TaskRuntime == nil {
					generation.Release()
					return fmt.Errorf("discord runtime generation is unavailable")
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
			})
			if handled {
				answered = replied
				return commandErr
			}
			if !compactOnly {
				if result := runControl.Steer("discord", conversationKey, text); result.Found {
					answered = true
					return publishDiscordBusOutbound(handlerCtx, bus, inbound.ChannelID, runtimecontrol.SteerFeedback(result.Found, result.Queued), replyTo, "discord:steer:"+inbound.MessageID)
				}
			}
		}
		taskID := discordTaskID(inbound.ChannelID, inbound.MessageID)
		generation, err := generations.Capture()
		if err != nil {
			return err
		}
		bundle := generation.Bundle()
		if bundle == nil || bundle.TaskRuntime == nil {
			generation.Release()
			return fmt.Errorf("discord runtime generation is unavailable")
		}
		// lightweightDecided: a decision-route check chose text, so the run skips the lightweight
		// rules and the pre-check below does not run again.
		lightweightDecided := false
		if isGroup && !compactOnly {
			stateMu.Lock()
			historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
			stateMu.Unlock()
			reactTool := discordtools.NewReactTool(discordToolAPI{api: api}, inbound.ChannelID, inbound.MessageID)
			// A $name reference asks for a task, so the group check offers no emoji reply for it.
			var groupReact tools.Tool
			if !runtimecore.HasCapabilityReference(text) {
				groupReact = reactTool
			}
			decision, accepted, decideErr := decideDiscordGroupTrigger(llmstats.WithRunID(handlerCtx, taskID), triggerOptions(bundle), inbound, botID, historySnapshot, groupReact)
			if decideErr != nil {
				generation.Release()
				logger.Warn("discord_addressing_llm_error", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "error", decideErr.Error())
				return nil
			}
			if !accepted {
				generation.Release()
				logger.Debug("discord_group_ignored", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "reason", decision.Reason,
					"llm_attempted", decision.AddressingLLMAttempted, "confidence", decision.Addressing.Confidence, "interject", decision.Addressing.Interject)
				if opts.GroupTriggerMode == groupTriggerTalkative {
					appendHistory(conversationKey, newDiscordInboundHistoryItem(discordJobFromInbound(inbound)))
				}
				recordUntriggered(inbound)
				return nil
			}
			if decision.ReactionHandled {
				generation.Release()
				job := discordJobFromInbound(inbound)
				items := []chathistory.ChatHistoryItem{newDiscordInboundHistoryItem(job)}
				if reaction := reactTool.LastReaction(); reaction != nil {
					items = append(items, newDiscordOutboundHistoryItem(job, botName, "[reacted: "+reaction.Emoji+"]", time.Now().UTC()))
				}
				appendHistory(conversationKey, items...)
				return nil
			}
			lightweightDecided = decision.UsedAddressingLLM && bundle.LightweightPrecheck
		}
		// A slash command needs a reply to fill its placeholder, so it is never answered by a reaction.
		if !lightweightDecided && !compactOnly && !fromInteraction && runtimecore.LightweightPrecheckApplies(text, len(inbound.ImageAttachments) > 0) {
			stateMu.Lock()
			historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
			stateMu.Unlock()
			reactTool := discordtools.NewReactTool(discordToolAPI{api: api}, inbound.ChannelID, inbound.MessageID)
			result, emoji := runtimecore.RunLightweightPrecheck(llmstats.WithRunID(handlerCtx, taskID), bundle, runtimecore.LightweightPrecheckRequest{
				Scene:      "discord.lightweight_decision",
				PersonaDir: d.RuntimePaths.PersonaDir,
				CurrentMessage: map[string]any{
					"guild_id":      inbound.GuildID,
					"channel_id":    inbound.ChannelID,
					"chat_type":     inbound.ChatType,
					"message_id":    inbound.MessageID,
					"user_id":       inbound.UserID,
					"text":          inbound.Text,
					"mention_users": append([]string(nil), inbound.MentionUserIDs...),
				},
				History: chathistory.BuildMessages(chathistory.ChannelDiscord, historySnapshot),
				Emojis:  strings.Split(discordReactionEmojis, ","),
				Logger:  logger,
				Deliver: func(ctx context.Context, emoji string) error {
					_, err := reactTool.Execute(ctx, map[string]any{"emoji": emoji})
					return err
				},
			})
			switch result {
			case runtimecore.PrecheckHandled:
				generation.Release()
				job := discordJobFromInbound(inbound)
				appendHistory(conversationKey, newDiscordInboundHistoryItem(job), newDiscordOutboundHistoryItem(job, botName, "[reacted: "+emoji+"]", time.Now().UTC()))
				return nil
			case runtimecore.PrecheckText:
				lightweightDecided = true
			}
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
		images := imagehistory.BuildFromAttachments(inbound.ImageAttachments, pathroots.New(resolution.WorkspaceDir, opts.FileCacheDir, d.RuntimePaths.StateDir))
		buildJob := func(version uint64) discordJob {
			admittedRoute := route
			job := discordJobFromInbound(inbound)
			job.TaskID = taskID
			job.ConversationKey = conversationKey
			job.Text = text
			job.Images = append([]chathistory.ChatHistoryImage(nil), images...)
			job.WorkspaceDir = resolution.WorkspaceDir
			job.FileCacheDir = opts.FileCacheDir
			job.Route = &admittedRoute
			job.Version = version
			job.Generation = generation
			job.FromInteraction = fromInteraction
			job.LightweightDecided = lightweightDecided
			return job
		}
		createdAt := inbound.SentAt.UTC()
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		if err := taskdomain.RecordTaskUpsert(daemonStore, daemonruntime.TaskInfo{
			ID: taskID, Status: daemonruntime.TaskQueued, Task: textutil.TruncateRunes(text, 2000), Model: route.ClientConfig.Model,
			Timeout: opts.TaskTimeout.String(), CreatedAt: createdAt, Conversation: discordTaskConversation(buildJob(0), botID),
			Result: map[string]any{"source": "discord", "discord_channel_id": inbound.ChannelID, "discord_guild_id": inbound.GuildID, "discord_message_id": inbound.MessageID, "discord_chat_type": inbound.ChatType, "discord_user_id": inbound.UserID},
		}, daemonruntime.TaskTrigger{Source: "discord", Event: "gateway_message", Ref: inbound.MessageID}); err != nil {
			generation.Release()
			return err
		}
		if err := runner.Enqueue(handlerCtx, conversationKey, buildJob); err != nil {
			generation.Release()
			markDiscordTaskFailed(logger, daemonStore, taskID, err.Error(), taskdomain.EndedByCancellation(handlerCtx, err))
			return err
		}
		// The run answers the slash command, or removes its placeholder when it ends.
		answered = true
		logger.Info("discord_task_enqueued", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "conversation_key", conversationKey, "text_len", len(text))
		return nil
	}

	busHandler := func(handlerCtx context.Context, message busruntime.BusMessage) error {
		if message.Channel != busruntime.ChannelDiscord {
			return fmt.Errorf("unsupported %s channel: %s", message.Direction, message.Channel)
		}
		switch message.Direction {
		case busruntime.DirectionInbound:
			if err := contactsService.ObserveInboundBusMessage(context.Background(), message, time.Now().UTC()); err != nil {
				logger.Warn("contacts_observe_bus_error", "channel", message.Channel, "error", err.Error())
			}
			return enqueueInbound(handlerCtx, message)
		case busruntime.DirectionOutbound:
			_, _, err := deliveryAdapter.Deliver(handlerCtx, message)
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

	handleMessage := func(messageCtx context.Context, msg discordapi.Message) {
		// A slash command that never reaches the bus (refused, or answered here) must not leave its
		// placeholder waiting; after a reply, finish finds nothing left to remove.
		published := false
		defer func() {
			if !published {
				interactions.finish(context.WithoutCancel(messageCtx), msg.ID)
			}
		}()
		inbound, channel, publish, normalizeErr := ingress.Normalize(messageCtx, msg)
		if normalizeErr != nil {
			logger.Warn("discord_message_unsupported", "channel_id", msg.ChannelID, "message_id", msg.ID, "error", normalizeErr.Error())
			return
		}
		if !publish {
			return
		}
		isGroup := inbound.ChatType == discordbus.ChatTypeGroup
		reply := func(text string) {
			replyTo := discordInboundReplyTarget(inbound, interactions.known(inbound.MessageID))
			if err := interactions.send(messageCtx, inbound.ChannelID, text, replyTo); err != nil {
				logger.Warn("discord_send_failed", "channel_id", inbound.ChannelID, "error", err.Error())
			}
		}
		if agentpair.IsControlMessage(inbound.Text) {
			if isGroup || !inbound.FromIsAgent {
				logger.Warn("agent_pair_failed", "channel", "discord", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "reason", "invalid_control_sender_or_scope")
				return
			}
			peer := discordInboundAgentPeer(inbound)
			_, handled, pairErr := pairManager.Handle(messageCtx, peer, inbound.Text)
			if pairErr != nil {
				logger.Warn("agent_pair_failed", "channel", "discord", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "peer_agent_id", peer.ID, "reason", "offer_rejected", "error", pairErr.Error())
			}
			if handled {
				return
			}
		}
		command, args := chatcommands.ParseCommand(inbound.Text)
		if chatcommands.NormalizeCommand(command) == "/pair" {
			if isGroup || inbound.FromIsAgent {
				logger.Warn("agent_pair_failed", "channel", "discord", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "reason", "pair_command_requires_private_human_sender")
				return
			}
			target, pairErr := discordPairTarget(messageCtx, contactsService, args)
			var status agentpair.Status
			if pairErr == nil {
				status, pairErr = pairManager.Start(messageCtx, "discord_user:"+inbound.UserID, target, "")
			}
			reply(discordPairReplyText(status, pairErr))
			return
		}
		if _, loaded := savedChatProfiles.LoadOrStore(inbound.ChannelID, true); !loaded {
			if profileErr := chatInfoStore.Put(messageCtx, chatinfo.Info{
				ChatID: "discord:" + inbound.ChannelID, Platform: "discord", Type: inbound.ChatType,
				Name: ingress.chatName(inbound, channel), FetchedAt: time.Now().UTC(),
			}); profileErr != nil {
				savedChatProfiles.Delete(inbound.ChannelID)
				logger.Warn("discord_chat_profile_write_failed", "channel_id", inbound.ChannelID, "error", profileErr.Error())
			}
		}
		if avatarURL := msg.Author.AvatarURL(); avatarURL != "" {
			avatarRefresher.Enqueue("discord_user:"+inbound.UserID, func(fetchCtx context.Context) ([]byte, bool, error) {
				return contacts.FetchContactAvatarURL(fetchCtx, nil, avatarURL)
			})
		}
		accepted, publishErr := inboundAdapter.HandleInboundMessage(messageCtx, inbound)
		published = accepted && publishErr == nil
		if publishErr != nil {
			logger.Warn("discord_bus_publish_error", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "error", publishErr.Error())
			return
		}
		if accepted {
			logger.Debug("discord_message_received", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID, "chat_type", inbound.ChatType, "text_len", len(inbound.Text))
		} else {
			logger.Debug("discord_message_deduped", "channel_id", inbound.ChannelID, "message_id", inbound.MessageID)
		}
	}

	interactionAllowed := func(interactionCtx context.Context, interaction discordapi.Interaction, actor discordapi.User) bool {
		if strings.TrimSpace(actor.ID) == "" || actor.Bot {
			return false
		}
		if strings.TrimSpace(interaction.GuildID) == "" {
			return allowlist.dmAllowed(actor.ID, false, false)
		}
		channel, err := ingress.channel(interactionCtx, interaction.ChannelID)
		if err != nil {
			logger.Warn("discord_interaction_channel_lookup_failed", "channel_id", interaction.ChannelID, "error", err.Error())
			return false
		}
		return allowlist.serverAllowed(interaction.GuildID, channel)
	}
	respondEphemeral := func(interactionCtx context.Context, interaction discordapi.Interaction, content string) {
		if err := api.RespondInteraction(interactionCtx, interaction.ID, interaction.Token, discordapi.InteractionResponse{
			Type: discordapi.InteractionResponseChannelMessage,
			Data: &discordapi.InteractionResponseData{Content: &content, Flags: discordapi.MessageFlagEphemeral, AllowedMentions: discordapi.NoMentions()},
		}); err != nil {
			logger.Warn("discord_interaction_response_failed", "interaction_id", interaction.ID, "error", err.Error())
		}
	}
	handleSlashCommand := func(interactionCtx context.Context, interaction discordapi.Interaction) {
		msg, ok := discordSlashCommandMessage(interaction, botID, time.Now())
		if !ok {
			return
		}
		inDM := strings.TrimSpace(interaction.GuildID) == ""
		if !interactionAllowed(interactionCtx, interaction, msg.Author) && !(inDM && discordBypassesAllowlist(msg.Content)) {
			respondEphemeral(interactionCtx, interaction, "You are not allowed to use this bot here.")
			return
		}
		// Discord needs an answer within three seconds: acknowledge with its "thinking…" placeholder,
		// which the first reply then replaces.
		if err := api.RespondInteraction(interactionCtx, interaction.ID, interaction.Token, discordapi.InteractionResponse{Type: discordapi.InteractionResponseDeferredChannelMessage}); err != nil {
			logger.Warn("discord_interaction_response_failed", "interaction_id", interaction.ID, "error", err.Error())
		} else {
			interactions.add(interaction.ID, interaction.Token)
		}
		if !ingressQueue.push(msg.ChannelID, func() { handleMessage(interactionCtx, msg) }) {
			logger.Warn("discord_ingress_queue_full", "channel_id", msg.ChannelID, "interaction_id", interaction.ID)
			interactions.finish(interactionCtx, interaction.ID)
		}
	}
	handleInteraction := func(interactionCtx context.Context, interaction discordapi.Interaction) {
		if interaction.Type == discordapi.InteractionTypeApplicationCommand {
			handleSlashCommand(interactionCtx, interaction)
			return
		}
		if interaction.Type != discordapi.InteractionTypeMessageComponent {
			return
		}
		approvalID, approved, ok := parseDiscordApprovalCustomID(interaction.Data.CustomID)
		if !ok {
			return
		}
		actor := interaction.Actor()
		if !interactionAllowed(interactionCtx, interaction, actor) {
			respondEphemeral(interactionCtx, interaction, "You are not allowed to decide this approval.")
			return
		}
		// Discord needs an answer within three seconds; acknowledge first, then decide, then edit
		// the approval message.
		if err := api.RespondInteraction(interactionCtx, interaction.ID, interaction.Token, discordapi.InteractionResponse{Type: discordapi.InteractionResponseDeferredUpdate}); err != nil {
			logger.Warn("discord_interaction_response_failed", "interaction_id", interaction.ID, "error", err.Error())
		}
		_, _, decisionErr := approvals.apply(interactionCtx, approvalID, approved, "discord:"+actor.ID, func(job discordJob) bool {
			return job.ChannelID == interaction.ChannelID
		})
		if errors.Is(decisionErr, runtimecore.ErrPendingApprovalClaimInFlight) {
			return
		}
		if decisionErr != nil {
			logger.Warn("discord_approval_decision_error", "approval_request_id", approvalID, "channel_id", interaction.ChannelID, "user_id", actor.ID, "error", decisionErr.Error())
		}
		approvals.settleMessage(interactionCtx, approvalID, approved, actor.ID, decisionErr)
	}

	var registerCommands sync.Once
	logger.Info("discord_runtime_start", "group_trigger_mode", opts.GroupTriggerMode, "allowed_guild_ids", len(opts.AllowedGuildIDs),
		"allowed_channel_ids", len(opts.AllowedChannelIDs), "allowed_user_ids", len(opts.AllowedUserIDs),
		"task_timeout", opts.TaskTimeout.String(), "max_concurrency", opts.MaxConcurrency)
	err = gateway.Run(ctx, func(eventCtx context.Context, event discordapi.Event) {
		switch event.Type {
		case discordapi.EventReady:
			var ready discordapi.ReadyEvent
			if decodeErr := discordapi.DecodeEvent(event, discordapi.EventReady, &ready); decodeErr == nil {
				logger.Info("discord_gateway_ready", "user_id", ready.User.ID, "session_id", ready.SessionID)
				appID := firstNonEmpty(ready.Application.ID, botID)
				interactions.setApplicationID(appID)
				registerCommands.Do(func() {
					go func() {
						registerCtx, cancel := context.WithTimeout(context.WithoutCancel(eventCtx), 30*time.Second)
						defer cancel()
						if err := api.SetGlobalCommands(registerCtx, appID, discordSlashCommands()); err != nil {
							logger.Warn("discord_slash_commands_register_failed", "application_id", appID, "error", err.Error())
							return
						}
						logger.Info("discord_slash_commands_registered", "application_id", appID, "count", len(discordSlashCommands()))
					}()
				})
			}
		case discordapi.EventGuildCreate:
			var guild discordapi.Guild
			if decodeErr := discordapi.DecodeEvent(event, discordapi.EventGuildCreate, &guild); decodeErr != nil {
				logger.Warn("discord_event_decode_failed", "type", event.Type, "error", decodeErr.Error())
				return
			}
			ingress.rememberGuild(guild)
		case discordapi.EventMessageCreate:
			var msg discordapi.Message
			if decodeErr := discordapi.DecodeEvent(event, discordapi.EventMessageCreate, &msg); decodeErr != nil {
				logger.Warn("discord_event_decode_failed", "type", event.Type, "error", decodeErr.Error())
				return
			}
			if msg.Author.ID == botID {
				return
			}
			messageCtx := context.WithoutCancel(eventCtx)
			if !ingressQueue.push(msg.ChannelID, func() { handleMessage(messageCtx, msg) }) {
				logger.Warn("discord_ingress_queue_full", "channel_id", msg.ChannelID, "message_id", msg.ID)
			}
		case discordapi.EventInteractionCreate:
			var interaction discordapi.Interaction
			if decodeErr := discordapi.DecodeEvent(event, discordapi.EventInteractionCreate, &interaction); decodeErr != nil {
				logger.Warn("discord_event_decode_failed", "type", event.Type, "error", decodeErr.Error())
				return
			}
			go handleInteraction(context.WithoutCancel(eventCtx), interaction)
		}
	})
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil {
		logger.Info("discord_runtime_stop", "reason", "context_canceled")
		return nil
	}
	var closeErr *discordapi.GatewayCloseError
	if errors.As(err, &closeErr) && closeErr.Code == discordapi.CloseDisallowedIntents {
		return fmt.Errorf("discord refused the Message Content intent that group_trigger_mode %q needs: enable it in the Developer Portal (Bot > Privileged Gateway Intents) or set discord.group_trigger_mode to strict", opts.GroupTriggerMode)
	}
	if err != nil {
		return fmt.Errorf("discord gateway: %w", err)
	}
	return nil
}

func discordRESTClient(opts RunOptions) (discordAPI, error) {
	if opts.api != nil {
		return opts.api, nil
	}
	if opts.BotToken == "" {
		return nil, fmt.Errorf("missing discord.bot_token (set via --discord-bot-token or MISTER_MORPH_DISCORD_BOT_TOKEN)")
	}
	return discordapi.NewClient(opts.BotToken, discordapi.ClientOptions{BaseURL: opts.BaseURL})
}

func discordGatewayClient(ctx context.Context, api discordAPI, opts RunOptions, logger *slog.Logger, onConnectionChange func(bool)) (discordGateway, error) {
	if opts.gateway != nil {
		return opts.gateway, nil
	}
	info, err := api.GatewayBot(ctx)
	if err != nil {
		return nil, fmt.Errorf("load discord gateway url: %w", err)
	}
	return discordapi.NewGateway(opts.BotToken, discordapi.GatewayOptions{
		URL: info.URL, Intents: gatewayIntents(opts.GroupTriggerMode), OnConnectionChange: onConnectionChange,
		OnReconnect: func(reconnectErr error, delay time.Duration) {
			logger.Warn("discord_gateway_reconnect_scheduled", "delay", delay.String(), "error", reconnectErr)
		},
	})
}

func discordChannelOverview(connected bool) map[string]any {
	return map[string]any{
		"configured": true, "running": "discord", "connected": connected,
		"discord_configured": true, "discord_running": true, "discord_connected": connected,
	}
}

func discordTaskID(channelID, messageID string) string {
	return daemonruntime.BuildTaskID("dc", channelID, messageID)
}

func markDiscordTaskFailed(logger *slog.Logger, store daemonruntime.TaskUpdater, taskID, message string, stopped bool) {
	if err := runtimecore.MarkTaskFailed(store, taskID, strings.TrimSpace(message), stopped); err != nil {
		logger.Error("discord_task_state_write_error", "task_id", taskID, "status", daemonruntime.TaskFailed, "error", err.Error())
	}
}

func markDiscordTaskCanceled(logger *slog.Logger, store daemonruntime.TaskUpdater, taskID string) {
	if store == nil || strings.TrimSpace(taskID) == "" {
		return
	}
	finishedAt := time.Now().UTC()
	if err := store.Update(taskID, func(info *daemonruntime.TaskInfo) {
		if info != nil && (info.Status == daemonruntime.TaskQueued || info.Status == daemonruntime.TaskRunning) {
			info.Status = daemonruntime.TaskCanceled
			info.Error = "discord runtime closed"
			info.FinishedAt = &finishedAt
		}
	}); err != nil {
		logger.Error("discord_task_state_write_error", "task_id", taskID, "status", daemonruntime.TaskCanceled, "error", err.Error())
	}
}
