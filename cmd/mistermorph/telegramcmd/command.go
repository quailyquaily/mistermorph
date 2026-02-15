package telegramcmd

import (
	"context"
	"encoding/json"
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
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/healthcheck"
	"github.com/quailyquaily/mistermorph/internal/heartbeatutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/maepruntime"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/retryutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/telegramutil"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/maep"
	"github.com/quailyquaily/mistermorph/memory"
	"github.com/quailyquaily/mistermorph/tools"
	telegramtools "github.com/quailyquaily/mistermorph/tools/telegram"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
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

func resolveHealthListen(cmd *cobra.Command) string {
	return healthcheck.NormalizeListen(configutil.FlagOrViperString(cmd, "health-listen", "health.listen"))
}

func newTelegramCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "telegram",
		Short: "Run a Telegram bot that chats with the agent",
		RunE: func(cmd *cobra.Command, args []string) error {
			token := strings.TrimSpace(configutil.FlagOrViperString(cmd, "telegram-bot-token", "telegram.bot_token"))
			if token == "" {
				return fmt.Errorf("missing telegram.bot_token (set via --telegram-bot-token or MISTER_MORPH_TELEGRAM_BOT_TOKEN)")
			}

			baseURL := "https://api.telegram.org"

			allowed := make(map[int64]bool)
			for _, s := range configutil.FlagOrViperStringArray(cmd, "telegram-allowed-chat-id", "telegram.allowed_chat_ids") {
				s = strings.TrimSpace(s)
				if s == "" {
					continue
				}
				id, err := strconv.ParseInt(s, 10, 64)
				if err != nil {
					return fmt.Errorf("invalid telegram.allowed_chat_ids entry %q: %w", s, err)
				}
				allowed[id] = true
			}

			logger, err := loggerFromViper()
			if err != nil {
				return err
			}
			slog.SetDefault(logger)
			inprocBus, err := busruntime.StartInproc(busruntime.BootstrapOptions{
				MaxInFlight: viper.GetInt("bus.max_inflight"),
				Logger:      logger,
				Component:   "telegram",
			})
			if err != nil {
				return err
			}
			defer inprocBus.Close()

			contactsStore := contacts.NewFileStore(statepaths.ContactsDir())
			contactsSvc := contacts.NewService(contactsStore)

			withMAEP := configutil.FlagOrViperBool(cmd, "with-maep", "telegram.with_maep")
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
						return err
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
				maepListenAddrs := configutil.FlagOrViperStringArray(cmd, "maep-listen", "maep.listen_addrs")
				maepNode, err = maepruntime.Start(cmd.Context(), maepruntime.StartOptions{
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

			requestTimeout := viper.GetDuration("llm.request_timeout")
			client, err := llmClientFromConfig(llmconfig.ClientConfig{
				Provider:       llmProviderFromViper(),
				Endpoint:       llmEndpointFromViper(),
				APIKey:         llmAPIKeyFromViper(),
				Model:          llmModelFromViper(),
				RequestTimeout: requestTimeout,
			})
			if err != nil {
				return err
			}
			if configutil.FlagOrViperBool(cmd, "inspect-request", "") {
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
			if configutil.FlagOrViperBool(cmd, "inspect-prompt", "") {
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
			model := llmModelFromViper()
			reg := registryFromViper()
			toolsutil.BindTodoUpdateToolLLM(reg, client, model)
			logOpts := logOptionsFromViper()

			cfg := agent.Config{
				MaxSteps:       viper.GetInt("max_steps"),
				ParseRetries:   viper.GetInt("parse_retries"),
				MaxTokenBudget: viper.GetInt("max_token_budget"),
			}
			pollTimeout := configutil.FlagOrViperDuration(cmd, "telegram-poll-timeout", "telegram.poll_timeout")
			if pollTimeout <= 0 {
				pollTimeout = 30 * time.Second
			}
			pollCtx := cmd.Context()
			if pollCtx == nil {
				pollCtx = context.Background()
			}
			taskTimeout := configutil.FlagOrViperDuration(cmd, "telegram-task-timeout", "telegram.task_timeout")
			if taskTimeout <= 0 {
				taskTimeout = viper.GetDuration("timeout")
			}
			if taskTimeout <= 0 {
				taskTimeout = 10 * time.Minute
			}
			maxConc := configutil.FlagOrViperInt(cmd, "telegram-max-concurrency", "telegram.max_concurrency")
			if maxConc <= 0 {
				maxConc = 3
			}
			sem := make(chan struct{}, maxConc)
			healthListen := resolveHealthListen(cmd)
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

			maepMaxTurnsPerSession := configuredMAEPMaxTurnsPerSession()
			maepSessionCooldown := configuredMAEPSessionCooldown()
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
				_, err := publishTelegramBusOutbound(ctx, inprocBus, chatID, text, "", correlationID)
				return err
			}

			fileCacheDir := strings.TrimSpace(configutil.FlagOrViperString(cmd, "file-cache-dir", "file_cache_dir"))
			if fileCacheDir == "" {
				fileCacheDir = "/var/cache/morph"
			}
			const filesEnabled = true
			const filesMaxBytes = int64(20 * 1024 * 1024)
			if err := telegramutil.EnsureSecureCacheDir(fileCacheDir); err != nil {
				return fmt.Errorf("telegram file cache dir: %w", err)
			}
			telegramCacheDir := filepath.Join(fileCacheDir, "telegram")
			if err := ensureSecureChildDir(fileCacheDir, telegramCacheDir); err != nil {
				return fmt.Errorf("telegram cache subdir: %w", err)
			}
			maxAge := viper.GetDuration("file_cache.max_age")
			maxFiles := viper.GetInt("file_cache.max_files")
			maxTotalBytes := viper.GetInt64("file_cache.max_total_bytes")
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
			aliases := configutil.FlagOrViperStringArray(cmd, "telegram-alias", "telegram.aliases")
			for i := range aliases {
				aliases[i] = strings.TrimSpace(aliases[i])
			}
			groupTriggerMode := strings.ToLower(strings.TrimSpace(configutil.FlagOrViperString(cmd, "telegram-group-trigger-mode", "telegram.group_trigger_mode")))
			if groupTriggerMode == "" {
				groupTriggerMode = "smart"
			}
			telegramHistoryCap := telegramHistoryCapForMode(groupTriggerMode)
			smartAddressingMaxChars := configutil.FlagOrViperInt(cmd, "telegram-smart-addressing-max-chars", "telegram.smart_addressing_max_chars")
			if smartAddressingMaxChars <= 0 {
				smartAddressingMaxChars = 24
			}
			addressingLLMTimeout := requestTimeout
			smartAddressingConfidence := configutil.FlagOrViperFloat64(cmd, "telegram-smart-addressing-confidence", "telegram.smart_addressing_confidence")
			if smartAddressingConfidence <= 0 {
				smartAddressingConfidence = 0.55
			}
			if smartAddressingConfidence > 1 {
				smartAddressingConfidence = 1
			}
			talkativeAddressingConfidence := configutil.FlagOrViperFloat64(cmd, "telegram-talkative-addressing-confidence", "telegram.talkative_addressing_confidence")
			if talkativeAddressingConfidence <= 0 {
				talkativeAddressingConfidence = 0.55
			}
			if talkativeAddressingConfidence > 1 {
				talkativeAddressingConfidence = 1
			}

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
				"smart_addressing_max_chars", smartAddressingMaxChars,
				"smart_addressing_confidence", smartAddressingConfidence,
				"talkative_addressing_confidence", talkativeAddressingConfidence,
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

			sharedGuard = guardFromViper(logger)
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

				go func(chatID int64, w *telegramChatWorker) {
					for job := range w.Jobs {
						// Global concurrency limit.
						sem <- struct{}{}
						func() {
							defer func() { <-sem }()

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
								typingStop = startTypingTicker(context.Background(), api, chatID, "typing", 4*time.Second)
								defer typingStop()
							}

							ctx, cancel := context.WithTimeout(context.Background(), taskTimeout)
							final, _, loadedSkills, reaction, runErr := runTelegramTask(ctx, logger, logOpts, client, reg, api, filesEnabled, fileCacheDir, filesMaxBytes, sharedGuard, cfg, allowed, job, botUser, model, h, telegramHistoryCap, sticky, requestTimeout, publishTelegramText)
							cancel()

							if runErr != nil {
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
								if _, err := publishTelegramBusOutbound(context.Background(), inprocBus, chatID, "error: "+runErr.Error(), "", fmt.Sprintf("telegram:error:%d:%d", chatID, job.MessageID)); err != nil {
									logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
								}
								return
							}

							var outText string
							if reaction == nil {
								outText = formatFinalOutput(final)
								if !job.IsHeartbeat {
									replyTo := ""
									if job.ReplyToMessageID > 0 {
										replyTo = strconv.FormatInt(job.ReplyToMessageID, 10)
									}
									if _, err := publishTelegramBusOutbound(context.Background(), inprocBus, chatID, outText, replyTo, fmt.Sprintf("telegram:message:%d:%d", chatID, job.MessageID)); err != nil {
										logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
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
						}()
					}
				}(chatID, w)

				return w
			}

			enqueueTelegramInbound = func(ctx context.Context, msg busruntime.BusMessage) error {
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
				select {
				case <-ctx.Done():
					return ctx.Err()
				case w.Jobs <- job:
					return nil
				}
			}

			hbEnabled := viper.GetBool("heartbeat.enabled")
			hbInterval := viper.GetDuration("heartbeat.interval")
			hbChecklist := statepaths.HeartbeatChecklistPath()
			if hbEnabled && hbInterval > 0 {
				const heartbeatChatID int64 = 0
				go func() {
					ticker := time.NewTicker(hbInterval)
					defer ticker.Stop()
					for {
						select {
						case <-cmd.Context().Done():
							return
						case <-ticker.C:
						}
						result := heartbeatutil.Tick(
							heartbeatState,
							func() (string, bool, error) {
								return buildHeartbeatTask(hbChecklist)
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
								meta := buildHeartbeatMeta("telegram", hbInterval, hbChecklist, checklistEmpty, extra)
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
						case <-cmd.Context().Done():
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
							final, _, loadedSkills, runErr := runMAEPTask(runCtx, logger, logOpts, client, reg, sharedGuard, cfg, model, peerID, h, sticky, task)
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
							"Note: if Bot Privacy Mode is enabled, I may not receive normal group messages (so aliases won't trigger unless I receive the message)."
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
						if !viper.GetBool("memory.enabled") {
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

						mgr := memory.NewManager(statepaths.MemoryDir(), viper.GetInt("memory.short_term_days"))
						maxItems := viper.GetInt("memory.injection.max_items")
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
							dec, ok, decErr := groupTriggerDecision(context.Background(), client, model, msg, botUser, botID, aliases, groupTriggerMode, smartAddressingMaxChars, addressingLLMTimeout, smartAddressingConfidence, talkativeAddressingConfidence, historySnapshot)
							if decErr != nil {
								logger.Warn("telegram_addressing_llm_error",
									"chat_id", chatID,
									"type", chatType,
									"error", decErr.Error(),
								)
								continue
							}
							if !ok {
								if dec.AddressingLLMAttempted {
									logger.Info("telegram_group_ignored",
										"chat_id", chatID,
										"type", chatType,
										"text_len", len(text),
										"addressing_llm", true,
										"llm_ok", dec.AddressingLLMOK,
										"llm_addressed", dec.AddressingLLMAddressed,
										"confidence", dec.AddressingLLMConfidence,
										"impulse", dec.AddressingImpulse,
										"reason", dec.Reason,
									)
								} else {
									logger.Debug("telegram_group_ignored",
										"chat_id", chatID,
										"type", chatType,
										"text_len", len(text),
									)
								}
								if strings.EqualFold(groupTriggerMode, "talkative") {
									appendIgnoredInboundHistory(rawText)
								}
								continue
							}
							if dec.UsedAddressingLLM {
								replyToMessageID = quoteReplyMessageIDForGroupTrigger(msg, dec)
								quoteReply := replyToMessageID > 0
								logger.Info("telegram_group_trigger",
									"chat_id", chatID,
									"type", chatType,
									"reason", dec.Reason,
									"confidence", dec.AddressingLLMConfidence,
									"impulse", dec.AddressingImpulse,
									"quote_reply", quoteReply,
								)
							} else {
								replyToMessageID = quoteReplyMessageIDForGroupTrigger(msg, dec)
								quoteReply := replyToMessageID > 0
								logger.Info("telegram_group_trigger",
									"chat_id", chatID,
									"type", chatType,
									"reason", dec.Reason,
									"quote_reply", quoteReply,
								)
							}
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
							if _, publishErr := publishTelegramBusOutbound(context.Background(), inprocBus, chatID, "file download error: "+err.Error(), "", fmt.Sprintf("telegram:file_download_error:%d:%d", chatID, msg.MessageID)); publishErr != nil {
								logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", chatID, "message_id", msg.MessageID, "bus_error_code", busErrorCodeString(publishErr), "error", publishErr.Error())
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
		},
	}

	cmd.Flags().String("telegram-bot-token", "", "Telegram bot token.")
	// Note: base_url is intentionally not configurable.
	cmd.Flags().StringArray("telegram-allowed-chat-id", nil, "Allowed chat id(s). If empty, allows all.")
	cmd.Flags().StringArray("telegram-alias", nil, "Bot alias keywords (group messages containing these may trigger a response).")
	cmd.Flags().String("telegram-group-trigger-mode", "smart", "Group trigger mode: strict|smart|talkative.")
	cmd.Flags().Int("telegram-smart-addressing-max-chars", 24, "In smart mode, max chars from message start for alias addressing (0 uses default).")
	cmd.Flags().Float64("telegram-smart-addressing-confidence", 0.55, "Minimum confidence (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Float64("telegram-talkative-addressing-confidence", 0.55, "In talkative mode, minimum confidence (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Bool("with-maep", false, "Start MAEP listener together with telegram mode.")
	cmd.Flags().StringArray("maep-listen", nil, "MAEP listen multiaddr for --with-maep (repeatable). Defaults to maep.listen_addrs or MAEP defaults.")
	cmd.Flags().Duration("telegram-poll-timeout", 30*time.Second, "Long polling timeout for getUpdates.")
	cmd.Flags().Duration("telegram-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("telegram-max-concurrency", 3, "Max number of chats processed concurrently.")
	cmd.Flags().String("file-cache-dir", "/var/cache/morph", "Global temporary file cache directory (used for Telegram file handling).")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_telegram_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_telegram_YYYYMMDD_HHmmss.md.")

	return cmd
}

func runTelegramTask(ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, client llm.Client, baseReg *tools.Registry, api *telegramAPI, filesEnabled bool, fileCacheDir string, filesMaxBytes int64, sharedGuard *guard.Guard, cfg agent.Config, allowedIDs map[int64]bool, job telegramJob, botUsername string, model string, history []chathistory.ChatHistoryItem, historyCap int, stickySkills []string, requestTimeout time.Duration, sendTelegramText func(context.Context, int64, string, string) error) (*agent.Final, *agent.Context, []string, *telegramtools.Reaction, error) {
	if sendTelegramText == nil {
		return nil, nil, nil, nil, fmt.Errorf("send telegram text callback is required")
	}
	task := job.Text
	historyRaw, err := json.MarshalIndent(map[string]any{
		"chat_history_messages": chathistory.BuildMessages(chathistory.ChannelTelegram, history),
	}, "", "  ")
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("render telegram history context: %w", err)
	}
	llmHistory := []llm.Message{{Role: "user", Content: string(historyRaw)}}
	if baseReg == nil {
		baseReg = registryFromViper()
		toolsutil.BindTodoUpdateToolLLM(baseReg, client, model)
	}

	// Per-run registry.
	reg := tools.NewRegistry()
	for _, t := range baseReg.All() {
		reg.Register(t)
	}
	registerPlanTool(reg, client, model)
	toolsutil.BindTodoUpdateToolLLM(reg, client, model)
	toolsutil.SetTodoUpdateToolAddContext(reg, todo.AddResolveContext{
		Channel:          "telegram",
		ChatType:         job.ChatType,
		ChatID:           job.ChatID,
		SpeakerUserID:    job.FromUserID,
		SpeakerUsername:  job.FromUsername,
		MentionUsernames: append([]string(nil), job.MentionUsers...),
		UserInputRaw:     job.Text,
	})
	toolAPI := newTelegramToolAPI(api)
	if api != nil {
		reg.Register(telegramtools.NewSendVoiceTool(toolAPI, job.ChatID, fileCacheDir, filesMaxBytes, nil))
		if filesEnabled {
			reg.Register(telegramtools.NewSendFileTool(toolAPI, job.ChatID, fileCacheDir, filesMaxBytes))
		}
	}
	var reactTool *telegramtools.ReactTool
	if api != nil && job.MessageID != 0 {
		reactTool = telegramtools.NewReactTool(toolAPI, job.ChatID, job.MessageID, allowedIDs)
		reg.Register(reactTool)
	}

	promptSpec, loadedSkills, skillAuthProfiles, err := promptSpecForTelegram(ctx, logger, logOpts, task, client, model, stickySkills)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	promptprofile.ApplyPersonaIdentity(&promptSpec, logger)
	promptprofile.AppendLocalToolNotesBlock(&promptSpec, logger)
	promptprofile.AppendPlanCreateGuidanceBlock(&promptSpec, reg)
	promptprofile.AppendTelegramRuntimeBlocks(&promptSpec, isGroupChat(job.ChatType), job.MentionUsers)

	var memManager *memory.Manager
	var memIdentity memory.Identity
	memReqCtx := memory.ContextPublic
	if viper.GetBool("memory.enabled") && job.FromUserID > 0 {
		if strings.ToLower(strings.TrimSpace(job.ChatType)) == "private" {
			memReqCtx = memory.ContextPrivate
		}
		id, err := (&memory.Resolver{}).ResolveTelegram(ctx, job.FromUserID)
		if err != nil {
			return nil, nil, loadedSkills, nil, fmt.Errorf("memory identity: %w", err)
		}
		if id.Enabled && strings.TrimSpace(id.SubjectID) != "" {
			memIdentity = id
			memManager = memory.NewManager(statepaths.MemoryDir(), viper.GetInt("memory.short_term_days"))
			if viper.GetBool("memory.injection.enabled") {
				maxItems := viper.GetInt("memory.injection.max_items")
				snap, err := memManager.BuildInjection(id.SubjectID, memReqCtx, maxItems)
				if err != nil {
					return nil, nil, loadedSkills, nil, fmt.Errorf("memory injection: %w", err)
				}
				if strings.TrimSpace(snap) != "" {
					promptprofile.AppendMemorySummariesBlock(&promptSpec, snap)
					if logger != nil {
						logger.Info("memory_injection_applied", "source", "telegram", "subject_id", id.SubjectID, "chat_id", job.ChatID, "snapshot_len", len(snap))
					}
				} else if logger != nil {
					logger.Debug("memory_injection_skipped", "source", "telegram", "reason", "empty_snapshot", "subject_id", id.SubjectID, "chat_id", job.ChatID)
				}
			} else if logger != nil {
				logger.Debug("memory_injection_skipped", "source", "telegram", "reason", "disabled")
			}
		} else if logger != nil {
			logger.Debug("memory_identity_unavailable", "source", "telegram", "enabled", id.Enabled, "subject_id", strings.TrimSpace(id.SubjectID))
		}
	}

	var planUpdateHook func(runCtx *agent.Context, update agent.PlanStepUpdate)
	if !job.IsHeartbeat {
		planUpdateHook = func(runCtx *agent.Context, update agent.PlanStepUpdate) {
			if runCtx == nil || runCtx.Plan == nil {
				return
			}
			msg, err := generateTelegramPlanProgressMessage(ctx, client, model, task, runCtx.Plan, update, requestTimeout)
			if err != nil {
				logger.Warn("telegram_plan_progress_error", "error", err.Error())
				return
			}
			if strings.TrimSpace(msg) == "" {
				return
			}
			correlationID := fmt.Sprintf("telegram:plan:%d:%d", job.ChatID, job.MessageID)
			if err := sendTelegramText(context.Background(), job.ChatID, msg, correlationID); err != nil {
				logger.Warn("telegram_bus_publish_error", "channel", busruntime.ChannelTelegram, "chat_id", job.ChatID, "message_id", job.MessageID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
			}
		}
	}

	engineOpts := []agent.Option{
		agent.WithLogger(logger),
		agent.WithLogOptions(logOpts),
		agent.WithSkillAuthProfiles(skillAuthProfiles, viper.GetBool("secrets.require_skill_profiles")),
		agent.WithGuard(sharedGuard),
	}
	if planUpdateHook != nil {
		engineOpts = append(engineOpts, agent.WithPlanStepUpdate(planUpdateHook))
	}
	engine := agent.New(
		client,
		reg,
		cfg,
		promptSpec,
		engineOpts...,
	)
	meta := job.Meta
	if meta == nil {
		meta = map[string]any{
			"trigger":               "telegram",
			"telegram_chat_id":      job.ChatID,
			"telegram_message_id":   job.MessageID,
			"telegram_chat_type":    job.ChatType,
			"telegram_from_user_id": job.FromUserID,
		}
	}
	botUsername = strings.TrimPrefix(strings.TrimSpace(botUsername), "@")
	if botUsername != "" {
		meta["telegram_bot_username"] = botUsername
	}
	final, agentCtx, err := engine.Run(ctx, task, agent.RunOptions{Model: model, History: llmHistory, Meta: meta})
	if err != nil {
		return final, agentCtx, loadedSkills, nil, err
	}

	var reaction *telegramtools.Reaction
	if reactTool != nil {
		reaction = reactTool.LastReaction()
		if reaction != nil && logger != nil {
			logger.Info("telegram_reaction_applied",
				"chat_id", reaction.ChatID,
				"message_id", reaction.MessageID,
				"emoji", reaction.Emoji,
				"source", reaction.Source,
			)
		}
	}

	if reaction == nil && !job.IsHeartbeat && memManager != nil && memIdentity.Enabled && strings.TrimSpace(memIdentity.SubjectID) != "" {
		if err := updateTelegramMemory(ctx, logger, client, model, memManager, memIdentity, job, history, historyCap, final, requestTimeout); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				retryutil.AsyncRetry(logger, "memory_update", 2*time.Second, requestTimeout, func(retryCtx context.Context) error {
					return updateTelegramMemory(retryCtx, logger, client, model, memManager, memIdentity, job, history, historyCap, final, requestTimeout)
				})
			}
			logger.Warn("memory_update_error", "error", err.Error())
		}
	}
	return final, agentCtx, loadedSkills, reaction, nil
}

func runMAEPTask(ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, client llm.Client, baseReg *tools.Registry, sharedGuard *guard.Guard, cfg agent.Config, model string, peerID string, history []llm.Message, stickySkills []string, task string) (*agent.Final, *agent.Context, []string, error) {
	if strings.TrimSpace(task) == "" {
		return nil, nil, nil, fmt.Errorf("empty maep task")
	}
	if baseReg == nil {
		baseReg = registryFromViper()
		toolsutil.BindTodoUpdateToolLLM(baseReg, client, model)
	}
	reg := buildMAEPRegistry(baseReg)
	registerPlanTool(reg, client, model)
	toolsutil.BindTodoUpdateToolLLM(reg, client, model)

	promptSpec, loadedSkills, skillAuthProfiles, err := promptSpecForTelegram(ctx, logger, logOpts, task, client, model, stickySkills)
	if err != nil {
		return nil, nil, nil, err
	}
	promptprofile.ApplyPersonaIdentity(&promptSpec, logger)
	promptprofile.AppendLocalToolNotesBlock(&promptSpec, logger)
	promptprofile.AppendPlanCreateGuidanceBlock(&promptSpec, reg)
	promptprofile.AppendMAEPReplyPolicyBlock(&promptSpec)

	engine := agent.New(
		client,
		reg,
		cfg,
		promptSpec,
		agent.WithLogger(logger),
		agent.WithLogOptions(logOpts),
		agent.WithSkillAuthProfiles(skillAuthProfiles, viper.GetBool("secrets.require_skill_profiles")),
		agent.WithGuard(sharedGuard),
	)
	final, runCtx, err := engine.Run(ctx, task, agent.RunOptions{
		Model:   model,
		History: history,
		Meta: map[string]any{
			"trigger": "maep_inbound",
		},
	})
	if err != nil {
		return final, runCtx, loadedSkills, err
	}
	return final, runCtx, loadedSkills, nil
}

func buildMAEPRegistry(baseReg *tools.Registry) *tools.Registry {
	reg := tools.NewRegistry()
	if baseReg == nil {
		return reg
	}
	for _, t := range baseReg.All() {
		name := strings.TrimSpace(t.Name())
		if name == "contacts_send" {
			continue
		}
		reg.Register(t)
	}
	return reg
}

func generateTelegramPlanProgressMessage(ctx context.Context, client llm.Client, model string, task string, plan *agent.Plan, update agent.PlanStepUpdate, requestTimeout time.Duration) (string, error) {
	if client == nil || plan == nil || update.CompletedIndex < 0 {
		return "", nil
	}
	total := len(plan.Steps)
	if total == 0 {
		return "", nil
	}

	completed := 0
	for i := range plan.Steps {
		if plan.Steps[i].Status == agent.PlanStatusCompleted {
			completed++
		}
	}

	payload := map[string]any{
		"task":             strings.TrimSpace(task),
		"plan_summary":     strings.TrimSpace(plan.Summary),
		"completed_index":  update.CompletedIndex,
		"completed_step":   strings.TrimSpace(update.CompletedStep),
		"next_index":       update.StartedIndex,
		"next_step":        strings.TrimSpace(update.StartedStep),
		"steps_completed":  completed,
		"steps_total":      total,
		"progress_percent": int(float64(completed) / float64(total) * 100),
	}
	systemPrompt, userPrompt, err := renderTelegramPlanProgressPrompts(payload)
	if err != nil {
		return "", err
	}

	req := llm.Request{
		Model:     model,
		ForceJSON: false,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Parameters: map[string]any{
			"max_tokens": 4096,
		},
	}

	if ctx == nil {
		ctx = context.Background()
	}
	planCtx := ctx
	cancel := func() {}
	if requestTimeout > 0 {
		planCtx, cancel = context.WithTimeout(ctx, requestTimeout)
	}
	defer cancel()

	result, err := client.Chat(llminspect.WithModelScene(planCtx, "telegram.plan_progress"), req)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Text), nil
}
