package telegram

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/maep"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	runtimeworker "github.com/quailyquaily/mistermorph/internal/channelruntime/worker"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/healthcheck"
	"github.com/quailyquaily/mistermorph/internal/heartbeatutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/maepruntime"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/telegramutil"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/maep"
	"github.com/quailyquaily/mistermorph/memory"
)

type telegramJob struct {
	ChatID           int64
	MessageID        int64
	ReplyToMessageID int64
	SentAt           time.Time
	ChatType         string
	FromUserID       int64
	FromUsername     string
	FromFirstName    string
	FromLastName     string
	FromDisplayName  string
	Text             string
	Version          uint64
	IsHeartbeat      bool
	Meta             map[string]any
	MentionUsers     []string
}

type telegramChatWorker struct {
	Jobs    chan telegramJob
	Version uint64
}

type maepSessionState struct {
	TurnCount         int
	CooldownUntil     time.Time
	UpdatedAt         time.Time
	InterestLevel     float64
	LowInterestRounds int
	PreferenceSynced  bool
}

const (
	defaultMAEPMaxTurnsPerSession = 6
	defaultMAEPSessionCooldown    = 72 * time.Hour
	defaultMAEPInterestLevel      = 0.60
	maepInterestStopThreshold     = 0.30
	maepInterestLowRoundsLimit    = 2
	maepWrapUpConfidenceThreshold = 0.70
	maepFeedbackNegativeThreshold = 0.55
	maepFeedbackPositiveThreshold = 0.60
)

type maepFeedbackClassification struct {
	SignalPositive float64 `json:"signal_positive"`
	SignalNegative float64 `json:"signal_negative"`
	SignalBored    float64 `json:"signal_bored"`
	NextAction     string  `json:"next_action"`
	Confidence     float64 `json:"confidence"`
}

func shouldRunInitFlow(initRequired bool, normalizedCmd string) bool {
	if !initRequired {
		return false
	}
	return strings.TrimSpace(normalizedCmd) == ""
}

func runTelegramLoop(ctx context.Context, d Dependencies, opts runtimeLoopOptions) error {
	token := strings.TrimSpace(opts.BotToken)
	if token == "" {
		return fmt.Errorf("missing telegram.bot_token (set via --telegram-bot-token or MISTER_MORPH_TELEGRAM_BOT_TOKEN)")
	}

	baseURL := "https://api.telegram.org"

	allowed := make(map[int64]bool)
	for _, id := range normalizeAllowedChatIDs(opts.AllowedChatIDs) {
		if id == 0 {
			continue
		}
		allowed[id] = true
	}

	logger, err := loggerFromDeps(d)
	if err != nil {
		return err
	}
	hooks := opts.Hooks
	pollCtx := ctx
	if pollCtx == nil {
		pollCtx = context.Background()
	}
	slog.SetDefault(logger)
	inprocBus, err := busruntime.StartInproc(busruntime.BootstrapOptions{
		MaxInFlight: opts.BusMaxInFlight,
		Logger:      logger,
		Component:   "telegram",
	})
	if err != nil {
		return err
	}
	defer inprocBus.Close()

	contactsStore := contacts.NewFileStore(statepaths.ContactsDir())
	contactsSvc := contacts.NewService(contactsStore)

	withMAEP := opts.WithMAEP
	var maepNode *maep.Node
	var maepInboundAdapter *maepbus.InboundAdapter
	var telegramInboundAdapter *telegrambus.InboundAdapter
	var maepDeliveryAdapter *maepbus.DeliveryAdapter
	var telegramDeliveryAdapter *telegrambus.DeliveryAdapter
	maepEventCh := make(chan maep.DataPushEvent, 64)
	var enqueueTelegramInbound func(context.Context, busruntime.BusMessage) error
	telegramInboundAdapter, err = telegrambus.NewInboundAdapter(telegrambus.InboundAdapterOptions{
		Bus:   inprocBus,
		Store: contactsStore,
	})
	if err != nil {
		return err
	}
	maepSvc := maep.NewService(maep.NewFileStore(statepaths.MAEPDir()))

	busHandler := func(ctx context.Context, msg busruntime.BusMessage) error {
		switch msg.Direction {
		case busruntime.DirectionInbound:
			if msg.Channel == busruntime.ChannelTelegram || msg.Channel == busruntime.ChannelMAEP {
				if err := contactsSvc.ObserveInboundBusMessage(context.Background(), msg, maepSvc, time.Now().UTC()); err != nil {
					logger.Warn("contacts_observe_bus_error", "channel", msg.Channel, "idempotency_key", msg.IdempotencyKey, "error", err.Error())
				}
			}
			switch msg.Channel {
			case busruntime.ChannelTelegram:
				if enqueueTelegramInbound == nil {
					return fmt.Errorf("telegram inbound handler is not initialized")
				}
				return enqueueTelegramInbound(ctx, msg)
			case busruntime.ChannelMAEP:
				event, err := maepbus.EventFromBusMessage(msg)
				if err != nil {
					return err
				}
				select {
				case maepEventCh <- event:
					logger.Debug("telegram_bus_inbound_forwarded", "channel", msg.Channel, "topic", msg.Topic, "idempotency_key", msg.IdempotencyKey)
					return nil
				default:
					return fmt.Errorf("maep inbound queue is full")
				}
			default:
				return fmt.Errorf("unsupported inbound channel: %s", msg.Channel)
			}
		case busruntime.DirectionOutbound:
			switch msg.Channel {
			case busruntime.ChannelTelegram:
				if telegramDeliveryAdapter == nil {
					return fmt.Errorf("telegram delivery adapter is not initialized")
				}
				_, _, err := telegramDeliveryAdapter.Deliver(ctx, msg)
				if err != nil {
					chatID, _ := telegramChatIDFromConversationKey(msg.ConversationKey)
					callErrorHook(ctx, logger, hooks, ErrorEvent{
						Stage:  ErrorStageDeliverOutbound,
						ChatID: chatID,
						Err:    err,
					})
					return err
				}
				event, eventErr := telegramOutboundEventFromBusMessage(msg)
				if eventErr != nil {
					callErrorHook(ctx, logger, hooks, ErrorEvent{
						Stage:  ErrorStageDeliverOutbound,
						ChatID: event.ChatID,
						Err:    eventErr,
					})
				} else {
					callOutboundHook(ctx, logger, hooks, event)
				}
				return nil
			case busruntime.ChannelMAEP:
				if maepDeliveryAdapter == nil {
					return fmt.Errorf("maep delivery adapter is not initialized")
				}
				_, _, err := maepDeliveryAdapter.Deliver(ctx, msg)
				return err
			default:
				return fmt.Errorf("unsupported outbound channel: %s", msg.Channel)
			}
		default:
			return fmt.Errorf("unsupported direction: %s", msg.Direction)
		}
	}
	for _, topic := range busruntime.AllTopics() {
		if err := inprocBus.Subscribe(topic, busHandler); err != nil {
			return err
		}
	}

	if withMAEP {
		maepInboundAdapter, err = maepbus.NewInboundAdapter(maepbus.InboundAdapterOptions{
			Bus:   inprocBus,
			Store: contactsStore,
		})
		if err != nil {
			return err
		}
		maepListenAddrs := append([]string(nil), opts.MAEPListenAddrs...)
		maepNode, err = maepruntime.Start(pollCtx, maepruntime.StartOptions{
			ListenAddrs: maepListenAddrs,
			Logger:      logger,
			OnDataPush: func(event maep.DataPushEvent) {
				accepted, publishErr := maepInboundAdapter.HandleDataPush(context.Background(), event)
				if publishErr != nil {
					logger.Warn("telegram_maep_bus_publish_error", "from_peer_id", event.FromPeerID, "topic", event.Topic, "bus_error_code", busErrorCodeString(publishErr), "error", publishErr.Error())
					return
				}
				if !accepted {
					logger.Debug("telegram_maep_bus_deduped", "from_peer_id", event.FromPeerID, "topic", event.Topic, "idempotency_key", event.IdempotencyKey)
				}
			},
		})
		if err != nil {
			return fmt.Errorf("start embedded maep: %w", err)
		}
		maepDeliveryAdapter, err = maepbus.NewDeliveryAdapter(maepbus.DeliveryAdapterOptions{
			Node: maepNode,
		})
		if err != nil {
			return err
		}
		defer maepNode.Close()
		logger.Info("telegram_maep_ready", "peer_id", maepNode.PeerID(), "addresses", maepNode.AddrStrings())
	}

	requestTimeout := opts.RequestTimeout
	client, err := llmClientFromConfig(d, llmconfig.ClientConfig{
		Provider:       llmProviderFromDeps(d),
		Endpoint:       llmEndpointFromDeps(d),
		APIKey:         llmAPIKeyFromDeps(d),
		Model:          llmModelFromDeps(d),
		RequestTimeout: requestTimeout,
	})
	if err != nil {
		return err
	}
	if opts.InspectRequest {
		inspector, err := llminspect.NewRequestInspector(llminspect.Options{
			Mode:            "telegram",
			Task:            "telegram",
			TimestampFormat: "20060102_150405",
		})
		if err != nil {
			return err
		}
		defer func() { _ = inspector.Close() }()
		if err := llminspect.SetDebugHook(client, inspector.Dump); err != nil {
			return fmt.Errorf("inspect-request requires uniai provider client")
		}
	}
	if opts.InspectPrompt {
		inspector, err := llminspect.NewPromptInspector(llminspect.Options{
			Mode:            "telegram",
			Task:            "telegram",
			TimestampFormat: "20060102_150405",
		})
		if err != nil {
			return err
		}
		defer func() { _ = inspector.Close() }()
		client = &llminspect.PromptClient{Base: client, Inspector: inspector}
	}
	model := llmModelFromDeps(d)
	reg := registryFromDeps(d)
	toolsutil.BindTodoUpdateToolLLM(reg, client, model)
	logOpts := logOptionsFromDeps(d)

	cfg := agent.Config{
		MaxSteps:       opts.AgentMaxSteps,
		ParseRetries:   opts.AgentParseRetries,
		MaxTokenBudget: opts.AgentMaxTokenBudget,
	}
	taskRuntimeOpts := runtimeTaskOptions{
		MemoryEnabled:               opts.MemoryEnabled,
		MemoryShortTermDays:         opts.MemoryShortTermDays,
		MemoryInjectionEnabled:      opts.MemoryInjectionEnabled,
		MemoryInjectionMaxItems:     opts.MemoryInjectionMaxItems,
		SecretsRequireSkillProfiles: opts.SecretsRequireSkillProfiles,
	}
	pollTimeout := opts.PollTimeout
	taskTimeout := opts.TaskTimeout
	maxConc := opts.MaxConcurrency
	sem := make(chan struct{}, maxConc)
	workersCtx, stopWorkers := context.WithCancel(pollCtx)
	defer stopWorkers()
	healthListen := healthcheck.NormalizeListen(opts.HealthListen)
	if healthListen != "" {
		healthServer, err := healthcheck.StartServer(pollCtx, logger, healthListen, "telegram")
		if err != nil {
			logger.Warn("telegram_health_server_start_error", "addr", healthListen, "error", err.Error())
		} else {
			defer func() {
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = healthServer.Shutdown(shutdownCtx)
				cancel()
			}()
		}
	}

	maepMaxTurnsPerSession := opts.MAEPMaxTurnsPerSession
	maepSessionCooldown := opts.MAEPSessionCooldown
	runtimeStore, err := maepruntime.NewStateStore(statepaths.MAEPDir())
	if err != nil {
		return fmt.Errorf("init telegram runtime state store: %w", err)
	}
	runtimeSnapshot, runtimeStateFound, err := runtimeStore.Load()
	if err != nil {
		logger.Warn("telegram_runtime_state_load_error", "error", err.Error())
		runtimeSnapshot = maepruntime.StateSnapshot{}
		runtimeStateFound = false
	}

	httpClient := &http.Client{Timeout: 60 * time.Second}
	api := newTelegramAPI(httpClient, baseURL, token)
	telegramDeliveryAdapter, err = telegrambus.NewDeliveryAdapter(telegrambus.DeliveryAdapterOptions{
		SendText: func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
			chatID, ok := target.(int64)
			if !ok {
				return fmt.Errorf("telegram target is invalid")
			}
			replyToMessageID := int64(0)
			replyToRaw := strings.TrimSpace(opts.ReplyTo)
			if replyToRaw != "" {
				parsed, parseErr := strconv.ParseInt(replyToRaw, 10, 64)
				if parseErr != nil || parsed <= 0 {
					return fmt.Errorf("telegram reply_to is invalid")
				}
				replyToMessageID = parsed
			}
			return api.sendMessageChunkedReply(ctx, chatID, text, replyToMessageID)
		},
	})
	if err != nil {
		return err
	}
	publishTelegramText := func(ctx context.Context, chatID int64, text string, correlationID string) error {
		replyTo := ""
		_, err := publishTelegramBusOutbound(ctx, inprocBus, chatID, text, replyTo, correlationID)
		if err != nil {
			callErrorHook(ctx, logger, hooks, ErrorEvent{
				Stage:  ErrorStagePublishOutbound,
				ChatID: chatID,
				Err:    err,
			})
			return err
		}
		return nil
	}

	fileCacheDir := strings.TrimSpace(opts.FileCacheDir)
	const filesEnabled = true
	const filesMaxBytes = int64(20 * 1024 * 1024)
	if err := telegramutil.EnsureSecureCacheDir(fileCacheDir); err != nil {
		return fmt.Errorf("telegram file cache dir: %w", err)
	}
	telegramCacheDir := filepath.Join(fileCacheDir, "telegram")
	if err := ensureSecureChildDir(fileCacheDir, telegramCacheDir); err != nil {
		return fmt.Errorf("telegram cache subdir: %w", err)
	}
	maxAge := opts.FileCacheMaxAge
	maxFiles := opts.FileCacheMaxFiles
	maxTotalBytes := opts.FileCacheMaxTotalBytes
	if err := telegramutil.CleanupFileCacheDir(telegramCacheDir, maxAge, maxFiles, maxTotalBytes); err != nil {
		logger.Warn("file_cache_cleanup_error", "error", err.Error())
	}

	var me *telegramUser
	for {
		me, err = api.getMe(pollCtx)
		if err == nil {
			break
		}
		if errors.Is(err, context.Canceled) || pollCtx.Err() != nil {
			logger.Info("telegram_stop", "reason", "context_canceled")
			return nil
		}
		logger.Warn("telegram_get_me_error", "error", err.Error())
		select {
		case <-pollCtx.Done():
			logger.Info("telegram_stop", "reason", "context_canceled")
			return nil
		case <-time.After(2 * time.Second):
		}
	}

	botUser := me.Username
	botID := me.ID
	groupTriggerMode := strings.ToLower(strings.TrimSpace(opts.GroupTriggerMode))
	telegramHistoryCap := telegramHistoryCapForMode(groupTriggerMode)
	addressingLLMTimeout := requestTimeout
	addressingConfidenceThreshold := opts.AddressingConfidenceThreshold
	addressingInterjectThreshold := opts.AddressingInterjectThreshold

	var (
		mu                 sync.Mutex
		history            = make(map[int64][]chathistory.ChatHistoryItem)
		initSessions       = make(map[int64]telegramInitSession)
		maepMu             sync.Mutex
		maepHistory        = make(map[string][]llm.Message)
		maepStickySkills   = make(map[string][]string)
		maepSessions       = make(map[string]maepSessionState)
		maepSessionDirty   bool
		maepVersion        uint64
		stickySkillsByChat = make(map[int64][]string)
		workers            = make(map[int64]*telegramChatWorker)
		lastActivity       = make(map[int64]time.Time)
		lastFromUser       = make(map[int64]int64)
		lastFromUsername   = make(map[int64]string)
		lastFromName       = make(map[int64]string)
		lastFromFirst      = make(map[int64]string)
		lastFromLast       = make(map[int64]string)
		lastChatType       = make(map[int64]string)
		knownMentions      = make(map[int64]map[string]string)
		heartbeatState     = &heartbeatutil.State{}
		offset             int64
	)
	if runtimeStateFound {
		restoredOffset, ok := runtimeSnapshot.ChannelOffsets[maepruntime.ChannelTelegram]
		if !ok {
			logger.Warn("telegram_runtime_state_missing_offset", "channel", maepruntime.ChannelTelegram)
		} else {
			offset = restoredOffset
			maepSessions = restoreMAEPSessionStates(runtimeSnapshot.SessionStates)
			logger.Info("telegram_runtime_state_loaded", "offset", offset, "session_states", len(maepSessions))
		}
	}
	initRequired := false
	if _, err := loadInitProfileDraft(); err == nil {
		initRequired = true
		logger.Info("telegram_init_pending", "reason", "IDENTITY.md and SOUL.md are draft")
	} else if !errors.Is(err, errInitProfilesNotDraft) {
		logger.Warn("telegram_init_check_error", "error", err.Error())
	}
	var sharedGuard *guard.Guard

	var (
		warningsMu                sync.Mutex
		systemWarnings            []string
		systemWarningsSeen        = make(map[string]bool)
		systemWarningsVersion     int
		systemWarningsSentVersion = make(map[int64]int)
	)

	logger.Info("telegram_start",
		"base_url", baseURL,
		"bot_username", botUser,
		"bot_id", botID,
		"poll_timeout", pollTimeout.String(),
		"task_timeout", taskTimeout.String(),
		"max_concurrency", maxConc,
		"telegram_history_mode_cap_talkative", 16,
		"telegram_history_mode_cap_others", 8,
		"reactions_enabled", true,
		"group_trigger_mode", groupTriggerMode,
		"group_reply_policy", "humanlike",
		"addressing_confidence_threshold", addressingConfidenceThreshold,
		"addressing_interject_threshold", addressingInterjectThreshold,
		"telegram_history_cap", telegramHistoryCap,
	)

	enqueueSystemWarning := func(msg string) int {
		msg = strings.TrimSpace(msg)
		if msg == "" {
			return systemWarningsVersion
		}
		warningsMu.Lock()
		defer warningsMu.Unlock()
		key := strings.ToLower(msg)
		if systemWarningsSeen[key] {
			return systemWarningsVersion
		}
		systemWarningsSeen[key] = true
		systemWarnings = append(systemWarnings, msg)
		systemWarningsVersion++
		return systemWarningsVersion
	}

	systemWarningsSnapshot := func() (string, int) {
		warningsMu.Lock()
		defer warningsMu.Unlock()
		if len(systemWarnings) == 0 {
			return "", 0
		}
		return strings.Join(systemWarnings, "\n"), systemWarningsVersion
	}

	markSystemWarningsSent := func(chatID int64, version int) {
		warningsMu.Lock()
		defer warningsMu.Unlock()
		if systemWarningsSentVersion[chatID] < version {
			systemWarningsSentVersion[chatID] = version
		}
	}

	sendSystemWarnings := func(chatID int64) {
		if len(allowed) > 0 && !allowed[chatID] {
			return
		}
		msg, version := systemWarningsSnapshot()
		if version == 0 {
			return
		}
		warningsMu.Lock()
		sentVersion := systemWarningsSentVersion[chatID]
		warningsMu.Unlock()
		if sentVersion >= version {
			return
		}
		_ = api.sendMessageMarkdownV2(context.Background(), chatID, msg, true)
		markSystemWarningsSent(chatID, version)
	}

	broadcastSystemWarnings := func() {
		msg, version := systemWarningsSnapshot()
		if version == 0 {
			return
		}
		mu.Lock()
		chatIDs := make([]int64, 0, len(lastActivity))
		for chatID := range lastActivity {
			chatIDs = append(chatIDs, chatID)
		}
		mu.Unlock()
		for _, chatID := range chatIDs {
			if len(allowed) > 0 && !allowed[chatID] {
				continue
			}
			warningsMu.Lock()
			sentVersion := systemWarningsSentVersion[chatID]
			warningsMu.Unlock()
			if sentVersion >= version {
				continue
			}
			_ = api.sendMessageMarkdownV2(context.Background(), chatID, msg, true)
			markSystemWarningsSent(chatID, version)
		}
	}

	sharedGuard = guardFromDeps(d, logger)
	if sharedGuard != nil {
		for _, warn := range sharedGuard.Warnings() {
			enqueueSystemWarning(warn)
		}
		broadcastSystemWarnings()
	}

	getOrStartWorkerLocked := func(chatID int64) *telegramChatWorker {
		if w, ok := workers[chatID]; ok && w != nil {
			return w
		}
		w := &telegramChatWorker{Jobs: make(chan telegramJob, 16)}
		workers[chatID] = w

		runtimeworker.Start(runtimeworker.StartOptions[telegramJob]{
			Ctx:  workersCtx,
			Sem:  sem,
			Jobs: w.Jobs,
			Handle: func(workerCtx context.Context, job telegramJob) {
				mu.Lock()
				h := append([]chathistory.ChatHistoryItem(nil), history[chatID]...)
				curVersion := w.Version
				sticky := append([]string(nil), stickySkillsByChat[chatID]...)
				mu.Unlock()

				// If there was a /reset after this job was queued, drop history for this run.
				if job.Version != curVersion {
					h = nil
				}

				var typingStop func()
				if !job.IsHeartbeat {
					typingStop = startTypingTicker(workerCtx, api, chatID, "typing", 4*time.Second)
					defer typingStop()
				}

				runCtx, cancel := context.WithTimeout(workerCtx, taskTimeout)
				final, _, loadedSkills, reaction, runErr := runTelegramTask(runCtx, d, logger, logOpts, client, reg, api, filesEnabled, fileCacheDir, filesMaxBytes, sharedGuard, cfg, allowed, job, botUser, model, h, telegramHistoryCap, sticky, requestTimeout, taskRuntimeOpts, publishTelegramText)
				cancel()

				if runErr != nil {
					if workerCtx.Err() != nil {
						return
					}
					callErrorHook(workerCtx, logger, hooks, ErrorEvent{
						Stage:     ErrorStageRunTask,
						ChatID:    chatID,
						MessageID: job.MessageID,
						Err:       runErr,
					})
					if job.IsHeartbeat {
						alert, msg := heartbeatState.EndFailure(runErr)
						if alert {
							logger.Warn("heartbeat_alert", "source", "telegram", "chat_id", chatID, "message", msg)
							mu.Lock()
							cur := history[chatID]
							cur = append(cur, newTelegramSystemHistoryItem(chatID, job.ChatType, msg, time.Now().UTC(), botUser))
							history[chatID] = trimChatHistoryItems(cur, telegramHistoryCap)
							mu.Unlock()
						} else {
							logger.Warn("heartbeat_error", "source", "telegram", "chat_id", chatID, "error", runErr.Error())
						}
						return
					}
					errorCorrelationID := fmt.Sprintf("telegram:error:%d:%d", chatID, job.MessageID)
					if _, err := publishTelegramBusOutbound(workerCtx, inprocBus, chatID, "error: "+runErr.Error(), "", errorCorrelationID); err != nil {
						logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
						callErrorHook(workerCtx, logger, hooks, ErrorEvent{
							Stage:     ErrorStagePublishErrorReply,
							ChatID:    chatID,
							MessageID: job.MessageID,
							Err:       err,
						})
					}
					return
				}

				var outText string
				if reaction == nil {
					outText = formatFinalOutput(final)
					if !job.IsHeartbeat {
						if workerCtx.Err() != nil {
							return
						}
						replyTo := ""
						if job.ReplyToMessageID > 0 {
							replyTo = strconv.FormatInt(job.ReplyToMessageID, 10)
						}
						outCorrelationID := fmt.Sprintf("telegram:message:%d:%d", chatID, job.MessageID)
						if _, err := publishTelegramBusOutbound(workerCtx, inprocBus, chatID, outText, replyTo, outCorrelationID); err != nil {
							logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
							callErrorHook(workerCtx, logger, hooks, ErrorEvent{
								Stage:     ErrorStagePublishOutbound,
								ChatID:    chatID,
								MessageID: job.MessageID,
								Err:       err,
							})
						}
					}
				}
				if job.IsHeartbeat {
					heartbeatState.EndSuccess(time.Now())
				}
				if job.IsHeartbeat {
					summary := strings.TrimSpace(outText)
					if summary == "" {
						summary = "empty"
					}
					logger.Info("heartbeat_summary", "source", "telegram", "chat_id", chatID, "message", summary)
				}

				mu.Lock()
				// Respect resets that happened while the task was running.
				if w.Version != curVersion {
					history[chatID] = nil
					stickySkillsByChat[chatID] = nil
				}
				if w.Version == curVersion && len(loadedSkills) > 0 {
					stickySkillsByChat[chatID] = capUniqueStrings(loadedSkills, telegramStickySkillsCap)
				}
				cur := history[chatID]
				if job.IsHeartbeat {
					if reaction == nil {
						cur = append(cur, newTelegramOutboundAgentHistoryItem(chatID, job.ChatType, outText, time.Now().UTC(), botUser))
					}
				} else {
					cur = append(cur, newTelegramInboundHistoryItem(job))
					if reaction != nil {
						note := "[reacted]"
						if emoji := strings.TrimSpace(reaction.Emoji); emoji != "" {
							note = "[reacted: " + emoji + "]"
						}
						cur = append(cur, newTelegramOutboundReactionHistoryItem(chatID, job.ChatType, note, reaction.Emoji, time.Now().UTC(), botUser))
					} else {
						cur = append(cur, newTelegramOutboundAgentHistoryItem(chatID, job.ChatType, outText, time.Now().UTC(), botUser))
					}
				}
				history[chatID] = trimChatHistoryItems(cur, telegramHistoryCap)
				mu.Unlock()
			},
		})

		return w
	}

	enqueueTelegramInbound = func(ctx context.Context, msg busruntime.BusMessage) error {
		if ctx == nil {
			ctx = workersCtx
		}
		inbound, err := telegrambus.InboundMessageFromBusMessage(msg)
		if err != nil {
			return err
		}
		text := strings.TrimSpace(inbound.Text)
		if text == "" {
			return fmt.Errorf("telegram inbound text is required")
		}
		mu.Lock()
		w := getOrStartWorkerLocked(inbound.ChatID)
		v := w.Version
		lastActivity[inbound.ChatID] = time.Now()
		if inbound.FromUserID > 0 {
			lastFromUser[inbound.ChatID] = inbound.FromUserID
			if inbound.FromUsername != "" {
				lastFromUsername[inbound.ChatID] = inbound.FromUsername
			}
			if inbound.FromDisplayName != "" {
				lastFromName[inbound.ChatID] = inbound.FromDisplayName
			}
			if inbound.FromFirstName != "" {
				lastFromFirst[inbound.ChatID] = inbound.FromFirstName
			}
			if inbound.FromLastName != "" {
				lastFromLast[inbound.ChatID] = inbound.FromLastName
			}
		}
		if inbound.ChatType != "" {
			lastChatType[inbound.ChatID] = inbound.ChatType
		}
		mu.Unlock()

		logger.Info("telegram_task_enqueued",
			"channel", msg.Channel,
			"topic", msg.Topic,
			"chat_id", inbound.ChatID,
			"type", inbound.ChatType,
			"idempotency_key", msg.IdempotencyKey,
			"conversation_key", msg.ConversationKey,
			"text_len", len(text),
		)
		job := telegramJob{
			ChatID:           inbound.ChatID,
			MessageID:        inbound.MessageID,
			ReplyToMessageID: inbound.ReplyToMessageID,
			SentAt:           inbound.SentAt,
			ChatType:         inbound.ChatType,
			FromUserID:       inbound.FromUserID,
			FromUsername:     inbound.FromUsername,
			FromFirstName:    inbound.FromFirstName,
			FromLastName:     inbound.FromLastName,
			FromDisplayName:  inbound.FromDisplayName,
			Text:             text,
			Version:          v,
			MentionUsers:     append([]string(nil), inbound.MentionUsers...),
		}
		if err := runtimeworker.Enqueue(ctx, workersCtx, w.Jobs, job); err != nil {
			return err
		}
		callInboundHook(ctx, logger, hooks, InboundEvent{
			ChatID:       inbound.ChatID,
			MessageID:    inbound.MessageID,
			ChatType:     inbound.ChatType,
			FromUserID:   inbound.FromUserID,
			Text:         text,
			MentionUsers: append([]string(nil), inbound.MentionUsers...),
		})
		return nil
	}

	hbEnabled := opts.HeartbeatEnabled
	hbInterval := opts.HeartbeatInterval
	hbChecklist := statepaths.HeartbeatChecklistPath()
	if hbEnabled && hbInterval > 0 {
		const heartbeatChatID int64 = 0
		go func() {
			ticker := time.NewTicker(hbInterval)
			defer ticker.Stop()
			for {
				select {
				case <-pollCtx.Done():
					return
				case <-ticker.C:
				}
				result := heartbeatutil.Tick(
					heartbeatState,
					func() (string, bool, error) {
						return buildHeartbeatTask(d, hbChecklist)
					},
					func(task string, checklistEmpty bool) string {
						mu.Lock()
						defer mu.Unlock()

						chatID := heartbeatChatID
						w := getOrStartWorkerLocked(chatID)
						if w == nil {
							return "worker_unavailable"
						}
						if len(w.Jobs) > 0 {
							return "worker_busy"
						}
						chatType := lastChatType[chatID]
						if strings.TrimSpace(chatType) == "" {
							chatType = "unknown"
						}
						fromUserID := lastFromUser[chatID]
						fromUsername := lastFromUsername[chatID]
						fromName := lastFromName[chatID]
						fromFirst := lastFromFirst[chatID]
						fromLast := lastFromLast[chatID]
						var mentionUsers []string
						if isGroupChat(chatType) {
							mentionUsers = mentionUsersSnapshot(knownMentions[chatID], mentionUserSnapshotLimit)
						}
						extra := map[string]any{
							"telegram_chat_id":       chatID,
							"telegram_chat_type":     chatType,
							"telegram_from_user_id":  fromUserID,
							"telegram_from_username": fromUsername,
							"telegram_from_name":     fromName,
							"queue_len":              len(w.Jobs),
						}
						_, lastSuccess, _, _ := heartbeatState.Snapshot()
						if !lastSuccess.IsZero() {
							extra["last_success_utc"] = lastSuccess.UTC().Format(time.RFC3339)
						}
						meta := buildHeartbeatMeta(d, "telegram", hbInterval, hbChecklist, checklistEmpty, extra)
						job := telegramJob{
							ChatID:          chatID,
							ChatType:        chatType,
							FromUserID:      fromUserID,
							FromUsername:    fromUsername,
							FromFirstName:   fromFirst,
							FromLastName:    fromLast,
							FromDisplayName: fromName,
							Text:            task,
							Version:         w.Version,
							IsHeartbeat:     true,
							Meta:            meta,
							MentionUsers:    mentionUsers,
						}
						select {
						case w.Jobs <- job:
							return ""
						default:
							return "worker_queue_full"
						}
					},
				)
				switch result.Outcome {
				case heartbeatutil.TickBuildError:
					if strings.TrimSpace(result.AlertMessage) != "" {
						logger.Warn("heartbeat_alert", "source", "telegram", "message", result.AlertMessage)
					} else {
						logger.Warn("telegram_heartbeat_task_error", "error", result.BuildError.Error())
					}
					enqueueSystemWarning(result.BuildError.Error())
					broadcastSystemWarnings()
				case heartbeatutil.TickSkipped:
					logger.Debug("heartbeat_skip", "source", "telegram", "reason", result.SkipReason)
				}
			}
		}()
	}

	if withMAEP && maepNode != nil {
		go func() {
			for {
				select {
				case <-pollCtx.Done():
					return
				case event := <-maepEventCh:
					if event.Deduped {
						continue
					}
					peerID := strings.TrimSpace(event.FromPeerID)
					if peerID == "" {
						continue
					}
					if !shouldAutoReplyMAEPTopic(event.Topic) {
						logger.Debug("telegram_maep_ignore_topic", "from_peer_id", peerID, "topic", event.Topic)
						continue
					}
					task, sessionID := extractMAEPTask(event)
					if strings.TrimSpace(task) == "" {
						logger.Debug("telegram_maep_ignore_empty_task", "from_peer_id", peerID, "topic", event.Topic)
						continue
					}
					sessionKey := maepSessionKey(peerID, event.Topic, sessionID)

					maepMu.Lock()
					historySnapshot := append([]llm.Message(nil), maepHistory[peerID]...)
					maepMu.Unlock()

					feedback := maepFeedbackClassification{
						NextAction: "continue",
						Confidence: 1,
					}
					feedbackCtx, feedbackCancel := context.WithTimeout(context.Background(), maepFeedbackTimeout(requestTimeout))
					classified, classifyErr := classifyMAEPFeedback(feedbackCtx, client, model, historySnapshot, task)
					feedbackCancel()
					if classifyErr != nil {
						logger.Warn("telegram_maep_feedback_classify_error", "from_peer_id", peerID, "topic", event.Topic, "error", classifyErr.Error())
					} else {
						feedback = classified
					}

					now := time.Now().UTC()
					if err := applyMAEPInboundFeedback(context.Background(), contactsSvc, maepSvc, peerID, event.Topic, sessionID, feedback, now); err != nil {
						logger.Warn("contacts_feedback_maep_error", "peer_id", peerID, "topic", event.Topic, "error", err.Error())
					}
					maepMu.Lock()
					sessionState := maepSessions[sessionKey]
					sessionState = applyMAEPFeedback(sessionState, feedback)
					nextSessionState, blockedByFeedback, blockedReason := maybeLimitMAEPSessionByFeedback(now, sessionState, feedback, maepSessionCooldown)
					if !blockedByFeedback {
						var allowedTurn bool
						nextSessionState, allowedTurn = allowMAEPSessionTurn(now, nextSessionState, maepMaxTurnsPerSession, maepSessionCooldown)
						if !allowedTurn {
							blockedByFeedback = true
							blockedReason = "turn_limit_or_cooldown"
						}
					}
					shouldRefreshPreferences := false
					if blockedByFeedback && !nextSessionState.PreferenceSynced {
						nextSessionState.PreferenceSynced = true
						shouldRefreshPreferences = true
					}
					maepSessions[sessionKey] = nextSessionState
					maepSessionDirty = true
					if blockedByFeedback {
						maepMu.Unlock()
						preferenceChanged := false
						if shouldRefreshPreferences {
							prefCtx, prefCancel := context.WithTimeout(context.Background(), maepFeedbackTimeout(requestTimeout))
							changed, prefErr := refreshMAEPPreferencesOnSessionEnd(prefCtx, contactsSvc, maepSvc, client, model, peerID, event.Topic, sessionID, task, historySnapshot, now, blockedReason)
							prefCancel()
							if prefErr != nil {
								logger.Warn("telegram_maep_preference_refresh_error", "from_peer_id", peerID, "topic", event.Topic, "session_key", sessionKey, "reason", blockedReason, "error", prefErr.Error())
							} else {
								preferenceChanged = changed
							}
						}
						logger.Info(
							"telegram_maep_session_limited",
							"from_peer_id", peerID,
							"session_key", sessionKey,
							"reason", blockedReason,
							"turn_count", nextSessionState.TurnCount,
							"interest_level", fmt.Sprintf("%.3f", nextSessionState.InterestLevel),
							"low_interest_rounds", nextSessionState.LowInterestRounds,
							"cooldown_until", nextSessionState.CooldownUntil.UTC().Format(time.RFC3339),
							"preference_refresh_attempted", shouldRefreshPreferences,
							"preference_changed", preferenceChanged,
						)
						continue
					}
					h := append([]llm.Message(nil), maepHistory[peerID]...)
					sticky := append([]string(nil), maepStickySkills[peerID]...)
					maepVersion++
					currentVersion := maepVersion
					maepMu.Unlock()

					logger.Info("telegram_maep_task_enqueued", "from_peer_id", peerID, "topic", event.Topic, "task_len", len(task))
					runCtx, cancel := context.WithTimeout(context.Background(), taskTimeout)
					final, _, loadedSkills, runErr := runMAEPTask(runCtx, d, logger, logOpts, client, reg, sharedGuard, cfg, model, peerID, h, sticky, taskRuntimeOpts, task)
					cancel()
					if runErr != nil {
						logger.Warn("telegram_maep_task_error", "from_peer_id", peerID, "topic", event.Topic, "error", runErr.Error())
						continue
					}

					output := strings.TrimSpace(formatFinalOutput(final))
					if output == "" {
						continue
					}
					pushCtx, pushCancel := context.WithTimeout(context.Background(), maepPushTimeout(requestTimeout))
					replyTopic := resolveMAEPReplyTopic(event.Topic)
					replyMessageID, pushErr := publishMAEPBusOutbound(pushCtx, inprocBus, peerID, replyTopic, output, sessionID, event.ReplyTo, fmt.Sprintf("maep:reply:%s", peerID))
					pushCancel()
					if pushErr != nil {
						logger.Warn("telegram_maep_reply_queue_error", "to_peer_id", peerID, "topic", replyTopic, "bus_error_code", busErrorCodeString(pushErr), "error", pushErr.Error())
						continue
					}
					logger.Info("telegram_maep_reply_queued", "to_peer_id", peerID, "topic", replyTopic, "message_id", replyMessageID)

					maepMu.Lock()
					if currentVersion == maepVersion {
						sessionState = maepSessions[sessionKey]
						sessionState.TurnCount++
						sessionState.UpdatedAt = time.Now().UTC()
						maepSessions[sessionKey] = sessionState
						maepSessionDirty = true
						if len(loadedSkills) > 0 {
							maepStickySkills[peerID] = capUniqueStrings(loadedSkills, telegramStickySkillsCap)
						}
						cur := maepHistory[peerID]
						cur = append(cur,
							llm.Message{Role: "user", Content: task},
							llm.Message{Role: "assistant", Content: output},
						)
						if len(cur) > telegramHistoryCap {
							cur = cur[len(cur)-telegramHistoryCap:]
						}
						maepHistory[peerID] = cur
					}
					maepMu.Unlock()
				}
			}
		}()
	}

	for {
		updates, nextOffset, err := api.getUpdates(pollCtx, offset, pollTimeout)
		if err != nil {
			if errors.Is(err, context.Canceled) || pollCtx.Err() != nil {
				logger.Info("telegram_stop", "reason", "context_canceled")
				return nil
			}
			if isTelegramPollTimeoutError(err) {
				logger.Debug("telegram_get_updates_timeout", "error", err.Error())
			} else {
				logger.Warn("telegram_get_updates_error", "error", err.Error())
			}
			time.Sleep(1 * time.Second)
			continue
		}
		offsetChanged := nextOffset != offset
		offset = nextOffset

		for _, u := range updates {
			msg := u.Message
			if msg == nil {
				msg = u.EditedMessage
			}
			if msg == nil {
				msg = u.ChannelPost
			}
			if msg == nil {
				msg = u.EditedChannelPost
			}
			if msg == nil || msg.Chat == nil {
				continue
			}
			chatID := msg.Chat.ID
			text := strings.TrimSpace(messageTextOrCaption(msg))
			rawText := text

			fromUserID := int64(0)
			fromUsername := ""
			fromFirst := ""
			fromLast := ""
			fromDisplay := ""
			if msg.From != nil && !msg.From.IsBot {
				fromUserID = msg.From.ID
				fromUsername = strings.TrimSpace(msg.From.Username)
				fromFirst = strings.TrimSpace(msg.From.FirstName)
				fromLast = strings.TrimSpace(msg.From.LastName)
				fromDisplay = telegramDisplayName(msg.From)
			}

			chatType := strings.ToLower(strings.TrimSpace(msg.Chat.Type))
			isGroup := chatType == "group" || chatType == "supergroup"
			messageSentAt := telegramMessageSentAt(msg)
			sendSystemWarnings(chatID)

			var mentionCandidates []string
			if isGroup {
				mentionCandidates = collectMentionCandidates(msg, botUser)
				if len(mentionCandidates) > 0 {
					mu.Lock()
					addKnownUsernames(knownMentions, chatID, mentionCandidates)
					mu.Unlock()
				}
			}
			appendIgnoredInboundHistory := func(ignoredText string) {
				ignoredText = strings.TrimSpace(ignoredText)
				if ignoredText == "" && messageHasDownloadableFile(msg) {
					ignoredText = "[attachment]"
				}
				if msg.ReplyTo != nil {
					if quoted := buildReplyContext(msg.ReplyTo); quoted != "" {
						if ignoredText == "" {
							ignoredText = "(empty)"
						}
						ignoredText = "Quoted message:\n> " + quoted + "\n\nUser request:\n" + ignoredText
					}
				}
				mu.Lock()
				cur := history[chatID]
				cur = append(cur, newTelegramInboundHistoryItem(telegramJob{
					ChatID:          chatID,
					MessageID:       msg.MessageID,
					SentAt:          messageSentAt,
					ChatType:        chatType,
					FromUserID:      fromUserID,
					FromUsername:    fromUsername,
					FromFirstName:   fromFirst,
					FromLastName:    fromLast,
					FromDisplayName: fromDisplay,
					Text:            ignoredText,
				}))
				history[chatID] = trimChatHistoryItems(cur, telegramHistoryCap)
				mu.Unlock()
			}

			cmdWord, cmdArgs := splitCommand(text)
			normalizedCmd := normalizeSlashCommand(cmdWord)
			if shouldRunInitFlow(initRequired, normalizedCmd) {
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				if strings.ToLower(strings.TrimSpace(chatType)) != "private" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "initialization is pending; please DM me first to finish setup", true)
					continue
				}
				mu.Lock()
				initSession, hasInitSession := initSessions[chatID]
				mu.Unlock()
				if !hasInitSession {
					draft, err := loadInitProfileDraft()
					if err != nil {
						if errors.Is(err, errInitProfilesNotDraft) {
							initRequired = false
						} else {
							_ = api.sendMessageMarkdownV2(context.Background(), chatID, "init failed: "+err.Error(), true)
							continue
						}
					} else {
						typingStop := startTypingTicker(context.Background(), api, chatID, "typing", 4*time.Second)
						initCtx, cancel := context.WithTimeout(context.Background(), initFlowTimeout(requestTimeout))
						questions, questionMsg, err := buildInitQuestions(initCtx, client, model, draft, text)
						cancel()
						typingStop()
						if err != nil {
							logger.Warn("telegram_init_question_error", "error", err.Error())
						}
						if len(questions) == 0 {
							questions = defaultInitQuestions(text)
						}
						if strings.TrimSpace(questionMsg) == "" {
							questionMsg = fallbackInitQuestionMessage(questions, text)
						}
						mu.Lock()
						initSessions[chatID] = telegramInitSession{
							Questions: questions,
							StartedAt: time.Now().UTC(),
						}
						mu.Unlock()
						_ = api.sendMessageMarkdownV2(context.Background(), chatID, questionMsg, true)
						continue
					}
				}
				if hasInitSession {
					if strings.TrimSpace(text) == "" {
						_ = api.sendMessageMarkdownV2(context.Background(), chatID, "please answer the init questions in one message", true)
						continue
					}
					draft, err := loadInitProfileDraft()
					if err != nil {
						if errors.Is(err, errInitProfilesNotDraft) {
							initRequired = false
							mu.Lock()
							for k := range initSessions {
								delete(initSessions, k)
							}
							mu.Unlock()
						} else {
							_ = api.sendMessageMarkdownV2(context.Background(), chatID, "init failed: "+err.Error(), true)
							continue
						}
					} else {
						typingStop := startTypingTicker(context.Background(), api, chatID, "typing", 4*time.Second)
						initCtx, cancel := context.WithTimeout(context.Background(), initFlowTimeout(requestTimeout))
						applyResult, err := applyInitFromAnswer(initCtx, client, model, draft, initSession, text, fromUsername, fromDisplay)
						cancel()
						typingStop()
						if err != nil {
							_ = api.sendMessageMarkdownV2(context.Background(), chatID, "init failed: "+err.Error(), true)
							continue
						}
						mu.Lock()
						initRequired = false
						for k := range initSessions {
							delete(initSessions, k)
						}
						mu.Unlock()
						typingStop2 := startTypingTicker(context.Background(), api, chatID, "typing", 4*time.Second)
						greetCtx, greetCancel := context.WithTimeout(context.Background(), initFlowTimeout(requestTimeout))
						greeting, greetErr := generatePostInitGreeting(greetCtx, client, model, draft, initSession, text, applyResult)
						greetCancel()
						typingStop2()
						if greetErr != nil {
							logger.Warn("telegram_init_greeting_error", "error", greetErr.Error())
						}
						_ = api.sendMessageMarkdownV2(context.Background(), chatID, greeting, true)
						continue
					}
				}
			}
			replyToMessageID := int64(0)
			switch normalizedCmd {
			case "/start", "/help":
				help := "Send a message and I will run it as an agent task.\n" +
					"Commands: /ask <task>, /echo <msg>, /mem, /humanize, /reset, /id\n\n" +
					"Group chats: use /ask <task>, reply to me, or mention @" + botUser + ".\n" +
					"You can also send a file (document/photo). It will be downloaded under file_cache_dir/telegram/ and the agent can process it.\n" +
					"Note: if Bot Privacy Mode is enabled, I may not receive normal group messages."
				_ = api.sendMessageMarkdownV2(context.Background(), chatID, help, true)
				continue
			case "/id":
				_ = api.sendMessageMarkdownV2(context.Background(), chatID, fmt.Sprintf("chat_id=%d type=%s", chatID, chatType), true)
				continue
			case "/mem":
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized, please contact the bot administrator", true)
					continue
				}
				if strings.ToLower(strings.TrimSpace(chatType)) != "private" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "please use /mem in the private chat", true)
					continue
				}
				if fromUserID <= 0 {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "failed to recognize the user (msg.from is nil)", true)
					continue
				}
				if !opts.MemoryEnabled {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "memory is not enabled (set memory.enabled=true)", true)
					continue
				}

				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				id, err := (&memory.Resolver{}).ResolveTelegram(ctx, fromUserID)
				cancel()
				if err != nil {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "memory identity error: "+err.Error(), true)
					continue
				}
				if !id.Enabled || strings.TrimSpace(id.SubjectID) == "" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "memory identity disabled", true)
					continue
				}

				mgr := memory.NewManager(statepaths.MemoryDir(), opts.MemoryShortTermDays)
				maxItems := opts.MemoryInjectionMaxItems
				snap, err := mgr.BuildInjection(id.SubjectID, memory.ContextPrivate, maxItems)
				if err != nil {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "memory load error: "+err.Error(), true)
					continue
				}
				if strings.TrimSpace(snap) == "" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "(empty)", true)
					continue
				}
				if err := api.sendMessageChunked(context.Background(), chatID, snap); err != nil {
					logger.Warn("telegram_send_error", "error", err.Error())
				}
				continue
			case "/humanize":
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				if strings.ToLower(strings.TrimSpace(chatType)) != "private" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "please use /humanize in the private chat", true)
					continue
				}
				typingStop := startTypingTicker(context.Background(), api, chatID, "typing", 4*time.Second)
				humanizeCtx, cancel := context.WithTimeout(context.Background(), initFlowTimeout(requestTimeout))
				updated, err := humanizeSoulProfile(humanizeCtx, client, model)
				cancel()
				typingStop()
				if err != nil {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "humanize failed: "+err.Error(), true)
					continue
				}
				if updated {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "ok (SOUL.md humanized)", true)
				} else {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "ok (SOUL.md unchanged)", true)
				}
				continue
			case "/reset":
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				mu.Lock()
				delete(history, chatID)
				delete(stickySkillsByChat, chatID)
				delete(knownMentions, chatID)
				delete(initSessions, chatID)
				if w := getOrStartWorkerLocked(chatID); w != nil {
					w.Version++
				}
				mu.Unlock()
				_ = api.sendMessageMarkdownV2(context.Background(), chatID, "ok (reset)", true)
				continue
			case "/ask":
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				if strings.TrimSpace(cmdArgs) == "" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "usage: /ask <task>, or mention the bot", true)
					continue
				}
				text = strings.TrimSpace(cmdArgs)
			case "/echo":
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				msg := strings.TrimSpace(cmdArgs)
				if msg == "" {
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "usage: /echo <msg>", true)
					continue
				}
				_ = api.sendMessageMarkdownV2(context.Background(), chatID, msg, true)
				continue
			default:
				if len(allowed) > 0 && !allowed[chatID] {
					logger.Warn("telegram_unauthorized_chat", "chat_id", chatID)
					_ = api.sendMessageMarkdownV2(context.Background(), chatID, "unauthorized", true)
					continue
				}
				if isGroup {
					if shouldSkipGroupReplyWithoutBodyMention(msg, text, botUser, botID) {
						logger.Info("telegram_group_ignored_reply_without_at_mention",
							"chat_id", chatID,
							"type", chatType,
							"text_len", len(text),
						)
						appendIgnoredInboundHistory(rawText)
						continue
					}
					mu.Lock()
					historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[chatID]...)
					mu.Unlock()
					dec, ok, decErr := groupTriggerDecision(context.Background(), client, model, msg, botUser, botID, groupTriggerMode, addressingLLMTimeout, addressingConfidenceThreshold, addressingInterjectThreshold, historySnapshot)
					if decErr != nil {
						logger.Warn("telegram_addressing_llm_error",
							"chat_id", chatID,
							"type", chatType,
							"error", decErr.Error(),
						)
						continue
					}
					if !ok {
						logger.Info("telegram_group_ignored",
							"chat_id", chatID,
							"type", chatType,
							"text_len", len(text),
							"llm_attempted", dec.AddressingLLMAttempted,
							"llm_ok", dec.AddressingLLMOK,
							"llm_addressed", dec.Addressing.Addressed,
							"confidence", dec.Addressing.Confidence,
							"wanna_interject", dec.Addressing.WannaInterject,
							"interject", dec.Addressing.Interject,
							"impulse", dec.Addressing.Impulse,
							"is_lightweight", dec.Addressing.IsLightweight,
							"reason", dec.Reason,
						)
						if strings.EqualFold(groupTriggerMode, "talkative") {
							appendIgnoredInboundHistory(rawText)
						}
						continue
					}
					replyToMessageID = quoteReplyMessageIDForGroupTrigger(msg, dec)
					quoteReply := replyToMessageID > 0
					logger.Info("telegram_group_trigger",
						"chat_id", chatID,
						"type", chatType,
						"reason", dec.Reason,
						"llm_addressed", dec.Addressing.Addressed,
						"confidence", dec.Addressing.Confidence,
						"wanna_interject", dec.Addressing.WannaInterject,
						"interject", dec.Addressing.Interject,
						"impulse", dec.Addressing.Impulse,
						"is_lightweight", dec.Addressing.IsLightweight,
						"quote_reply", quoteReply,
					)
					text = strings.TrimSpace(rawText)
					if strings.TrimSpace(text) == "" && !messageHasDownloadableFile(msg) && msg.ReplyTo == nil {
						_ = api.sendMessageMarkdownV2(context.Background(), chatID, "usage: /ask <task> (or send text with a mention/reply)", true)
						continue
					}
				} else {
					if strings.TrimSpace(text) == "" && !messageHasDownloadableFile(msg) {
						continue
					}
				}
			}

			var downloaded []telegramDownloadedFile
			if filesEnabled && (messageHasDownloadableFile(msg) || (msg.ReplyTo != nil && messageHasDownloadableFile(msg.ReplyTo))) {
				telegramCacheDir := filepath.Join(fileCacheDir, "telegram")
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				downloaded, err = downloadTelegramMessageFiles(ctx, api, telegramCacheDir, filesMaxBytes, msg, chatID)
				cancel()
				if err != nil {
					correlationID := fmt.Sprintf("telegram:file_download_error:%d:%d", chatID, msg.MessageID)
					if _, publishErr := publishTelegramBusOutbound(context.Background(), inprocBus, chatID, "file download error: "+err.Error(), "", correlationID); publishErr != nil {
						logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "message_id", msg.MessageID, "bus_error_code", busErrorCodeString(publishErr), "error", publishErr.Error())
						callErrorHook(context.Background(), logger, hooks, ErrorEvent{
							Stage:     ErrorStagePublishFileDownloadError,
							ChatID:    chatID,
							MessageID: msg.MessageID,
							Err:       publishErr,
						})
					}
					continue
				}
			}
			if strings.TrimSpace(text) == "" && len(downloaded) > 0 {
				text = "Please process the uploaded file(s)."
			}
			if len(downloaded) > 0 {
				text = appendDownloadedFilesToTask(text, downloaded)
			}
			if msg.ReplyTo != nil {
				quoted := buildReplyContext(msg.ReplyTo)
				if quoted != "" {
					if strings.TrimSpace(text) == "" {
						text = "Please read the quoted message, and proceed according to the previous context, or your understanding, in the same langauge."
					}
					text = "Quoted message:\n> " + quoted + "\n\nUser request:\n" + strings.TrimSpace(text)
				}
			}
			if fromUserID > 0 {
				observedAt := time.Now().UTC()
				if err := applyTelegramInboundFeedback(context.Background(), contactsSvc, chatID, chatType, fromUserID, fromUsername, observedAt); err != nil {
					logger.Warn("contacts_feedback_telegram_error", "chat_id", chatID, "user_id", fromUserID, "error", err.Error())
				}
			}

			mentionUsers := dedupeNonEmptyStrings(mentionCandidates)
			if isGroup && mentionUserSnapshotLimit > 0 && len(mentionUsers) > mentionUserSnapshotLimit {
				mentionUsers = mentionUsers[:mentionUserSnapshotLimit]
			}
			accepted, publishErr := telegramInboundAdapter.HandleInboundMessage(context.Background(), telegrambus.InboundMessage{
				ChatID:           chatID,
				MessageID:        msg.MessageID,
				ReplyToMessageID: replyToMessageID,
				SentAt:           messageSentAt,
				ChatType:         chatType,
				FromUserID:       fromUserID,
				FromUsername:     fromUsername,
				FromFirstName:    fromFirst,
				FromLastName:     fromLast,
				FromDisplayName:  fromDisplay,
				Text:             text,
				MentionUsers:     mentionUsers,
			})
			if publishErr != nil {
				logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "message_id", msg.MessageID, "bus_error_code", busErrorCodeString(publishErr), "error", publishErr.Error())
				callErrorHook(context.Background(), logger, hooks, ErrorEvent{
					Stage:     ErrorStagePublishInbound,
					ChatID:    chatID,
					MessageID: msg.MessageID,
					Err:       publishErr,
				})
				continue
			}
			if !accepted {
				logger.Debug("telegram_bus_inbound_deduped", "chat_id", chatID, "message_id", msg.MessageID)
				continue
			}
		}

		persistNeeded := offsetChanged
		var maepSessionsSnapshot map[string]maepSessionState
		maepMu.Lock()
		if maepSessionDirty {
			persistNeeded = true
			maepSessionDirty = false
		}
		if persistNeeded {
			maepSessionsSnapshot = cloneMAEPSessionStates(maepSessions)
		}
		maepMu.Unlock()

		if persistNeeded {
			snapshot := maepruntime.StateSnapshot{
				ChannelOffsets: map[string]int64{
					maepruntime.ChannelTelegram: offset,
				},
				SessionStates: exportMAEPSessionStates(maepSessionsSnapshot),
			}
			if err := runtimeStore.Save(snapshot); err != nil {
				logger.Warn("telegram_runtime_state_persist_error", "error", err.Error())
			}
		}
	}
}

func telegramOutboundEventFromBusMessage(msg busruntime.BusMessage) (OutboundEvent, error) {
	chatID, err := telegramChatIDFromConversationKey(msg.ConversationKey)
	if err != nil {
		return OutboundEvent{}, err
	}
	env, err := msg.Envelope()
	if err != nil {
		return OutboundEvent{}, err
	}
	replyToRaw := strings.TrimSpace(msg.Extensions.ReplyTo)
	if replyToRaw == "" {
		replyToRaw = strings.TrimSpace(env.ReplyTo)
	}
	replyToMessageID := int64(0)
	if replyToRaw != "" {
		if parsed, parseErr := strconv.ParseInt(replyToRaw, 10, 64); parseErr == nil && parsed > 0 {
			replyToMessageID = parsed
		}
	}
	return OutboundEvent{
		ChatID:           chatID,
		ReplyToMessageID: replyToMessageID,
		Text:             strings.TrimSpace(env.Text),
		CorrelationID:    strings.TrimSpace(msg.CorrelationID),
		Kind:             telegramOutboundKind(msg.CorrelationID),
	}, nil
}

func telegramChatIDFromConversationKey(conversationKey string) (int64, error) {
	const prefix = "tg:"
	if !strings.HasPrefix(conversationKey, prefix) {
		return 0, fmt.Errorf("telegram conversation key is invalid")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(conversationKey, prefix))
	if raw == "" {
		return 0, fmt.Errorf("telegram conversation key is invalid")
	}
	chatID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("telegram conversation key is invalid: %w", err)
	}
	return chatID, nil
}

func telegramOutboundKind(correlationID string) string {
	id := strings.ToLower(strings.TrimSpace(correlationID))
	switch {
	case strings.Contains(id, ":plan:"):
		return "plan_progress"
	case strings.Contains(id, ":error:") || strings.Contains(id, "file_download_error"):
		return "error"
	default:
		return "message"
	}
}
