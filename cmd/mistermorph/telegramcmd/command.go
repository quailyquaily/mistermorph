package telegramcmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/maep"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/entryutil"
	"github.com/quailyquaily/mistermorph/internal/heartbeatutil"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
	"github.com/quailyquaily/mistermorph/internal/jsonutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/maepruntime"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
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

			legacyHistoryMax := configutil.FlagOrViperInt(cmd, "telegram-history-max-messages", "telegram.history_max_messages")
			if legacyHistoryMax <= 0 {
				legacyHistoryMax = 20
			}
			maepMaxTurnsPerSession := configuredMAEPMaxTurnsPerSession()
			maepSessionCooldown := configuredMAEPSessionCooldown()
			runtimeStore, err := maepruntime.NewStateStore(statepaths.MAEPDir())
			if err != nil {
				return fmt.Errorf("init telegram runtime state store: %w", err)
			}
			runtimeSnapshot, runtimeStateFound, err := runtimeStore.Load()
			if err != nil {
				return fmt.Errorf("load telegram runtime state: %w", err)
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

			me, err := api.getMe(context.Background())
			if err != nil {
				return err
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
					return fmt.Errorf("runtime state missing channel offset %q", maepruntime.ChannelTelegram)
				}
				offset = restoredOffset
				maepSessions = restoreMAEPSessionStates(runtimeSnapshot.SessionStates)
				logger.Info("telegram_runtime_state_loaded", "offset", offset, "session_states", len(maepSessions))
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
				"telegram_history_max_messages_deprecated", true,
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
							final, _, loadedSkills, reaction, runErr := runTelegramTask(ctx, logger, logOpts, client, reg, api, filesEnabled, fileCacheDir, filesMaxBytes, sharedGuard, cfg, allowed, job, model, h, telegramHistoryCap, sticky, requestTimeout, publishTelegramText)
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
								if len(cur) > legacyHistoryMax {
									cur = cur[len(cur)-legacyHistoryMax:]
								}
								maepHistory[peerID] = cur
							}
							maepMu.Unlock()
						}
					}
				}()
			}

			pollCtx := cmd.Context()
			if pollCtx == nil {
				pollCtx = context.Background()
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

					cmdWord, cmdArgs := splitCommand(text)
					normalizedCmd := normalizeSlashCommand(cmdWord)
					if initRequired {
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
									logger.Debug("telegram_group_ignored",
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
									ignoredText := strings.TrimSpace(rawText)
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
						return fmt.Errorf("persist telegram runtime state: %w", err)
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
	cmd.Flags().Int("telegram-history-max-messages", 20, "Deprecated. Telegram history now uses mode caps (talkative=16, others=8).")
	_ = cmd.Flags().MarkDeprecated("telegram-history-max-messages", "deprecated: telegram history now uses mode-based caps (talkative=16, others=8)")
	cmd.Flags().String("file-cache-dir", "/var/cache/morph", "Global temporary file cache directory (used for Telegram file handling).")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_telegram_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_telegram_YYYYMMDD_HHmmss.md.")

	return cmd
}

func runTelegramTask(ctx context.Context, logger *slog.Logger, logOpts agent.LogOptions, client llm.Client, baseReg *tools.Registry, api *telegramAPI, filesEnabled bool, fileCacheDir string, filesMaxBytes int64, sharedGuard *guard.Guard, cfg agent.Config, allowedIDs map[int64]bool, job telegramJob, model string, history []chathistory.ChatHistoryItem, historyCap int, stickySkills []string, requestTimeout time.Duration, sendTelegramText func(context.Context, int64, string, string) error) (*agent.Final, *agent.Context, []string, *telegramReaction, error) {
	if sendTelegramText == nil {
		return nil, nil, nil, nil, fmt.Errorf("send telegram text callback is required")
	}
	task := job.Text
	renderedHistoryMsg, err := chathistory.RenderContextUserMessage(chathistory.ChannelTelegram, history)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("render telegram history context: %w", err)
	}
	llmHistory := make([]llm.Message, 0, 1)
	if strings.TrimSpace(renderedHistoryMsg.Content) != "" {
		llmHistory = append(llmHistory, renderedHistoryMsg)
	}
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
	reg.Register(newTelegramSendVoiceTool(api, job.ChatID, fileCacheDir, filesMaxBytes, nil))
	if filesEnabled && api != nil {
		reg.Register(newTelegramSendFileTool(api, job.ChatID, fileCacheDir, filesMaxBytes))
	}
	var reactTool *telegramReactTool
	if api != nil && job.MessageID != 0 {
		reactTool = newTelegramReactTool(api, job.ChatID, job.MessageID, allowedIDs)
		reg.Register(reactTool)
	}

	promptSpec, loadedSkills, skillAuthProfiles, err := promptSpecForTelegram(ctx, logger, logOpts, task, client, model, stickySkills)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	promptprofile.ApplyPersonaIdentity(&promptSpec, logger)
	promptprofile.AppendLocalToolNotesBlock(&promptSpec, logger)
	applyChatPersonaRules(&promptSpec)

	// Telegram replies are rendered using Telegram Markdown (MarkdownV2 first; fallback to Markdown/plain).
	// Underscores in identifiers like "new_york" will render as italics unless the model wraps them in
	// backticks. Give the model a channel-specific reminder.
	promptSpec.Rules = append(promptSpec.Rules,
		"In your final.output string, write for Telegram MarkdownV2 with LIMITED syntax only: *bold*, _italic_, __underline__, ~strikethrough~, ||spoiler||. Avoid inline code, code blocks, or any other Markdown features. If unsure, output plain text. Escape underscores in identifiers (e.g., new\\_york) instead of using backticks.",
	)
	applyTelegramGroupRuntimePromptRules(&promptSpec, job.ChatType, job.MentionUsers)
	promptSpec.Rules = append(promptSpec.Rules,
		"If you need to send a Telegram voice message: call telegram_send_voice. If you do not already have a voice file path, do NOT ask the user for one; instead call telegram_send_voice without path and provide a short `text` to synthesize from the current context.",
	)
	promptSpec.Rules = append(promptSpec.Rules,
		"If a lightweight emoji reaction is sufficient, call telegram_react and do NOT send an extra text reply.",
	)

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
					promptSpec.Blocks = append(promptSpec.Blocks, agent.PromptBlock{
						Title:   "Memory Summaries",
						Content: snap,
					})
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
	final, agentCtx, err := engine.Run(ctx, task, agent.RunOptions{Model: model, History: llmHistory, Meta: meta})
	if err != nil {
		return final, agentCtx, loadedSkills, nil, err
	}

	var reaction *telegramReaction
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

func applyTelegramGroupRuntimePromptRules(spec *agent.PromptSpec, chatType string, mentionUsers []string) {
	if spec == nil || !isGroupChat(chatType) {
		return
	}
	if len(mentionUsers) > 0 {
		spec.Blocks = append(spec.Blocks, agent.PromptBlock{
			Title:   "[Group Usernames]",
			Content: strings.Join(mentionUsers, "\n"),
		})
	}

	notes := []string{
		"- Participate, but do not dominate the group thread.",
		"- Be concise, be natural, do not over-explain.",
		"- Send text only when it adds clear incremental value beyond prior context.",
		"- If no incremental value, prefer lightweight acknowledgement instead of text.",
		"- Avoid triple-tap: never split one thought across multiple short follow-up messages.",
		"- Use `@username` to mention someone if you can find their username from the message history or [Group Usernames]. " +
			"For example, [Nickname](tg:@username); don't invent username.",
		"- Send text only when it adds clear incremental value; otherwise prefer a lightweight acknowledgement, send a reaction by using `telegram_react`",
		"- Never send multiple fragmented follow-up messages for one incoming group message; combine into one concise reply (anti triple-tap).",
	}

	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   "Group Reply Policy",
		Content: strings.Join(notes, "\n"),
	})
	spec.Rules = append(spec.Rules,
		"Prefer telegram_react when a lightweight acknowledgement is enough, and avoid sending extra text.",
		"Never send multiple fragmented follow-up messages for one incoming group message; combine into one concise reply (anti triple-tap).",
	)
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
	applyChatPersonaRules(&promptSpec)
	// applyMAEPReplyPromptRules(&promptSpec)

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

func applyMAEPReplyPromptRules(spec *agent.PromptSpec) {
	if spec == nil {
		return
	}
	spec.Rules = append(spec.Rules,
		"Your final.output will be sent verbatim to a remote peer as a chat message.",
		"Reply conversationally and naturally. Do NOT include protocol metadata or operational logs.",
		"Never mention topics/protocol labels (e.g. dm.reply.v1, dm.checkin.v1, share.proactive.v1, chat.message), session_id, message_id, peer_id, contact_id, idempotency_key, or tool invocation details.",
		"Do not report send/retry status, failure causes, or remediation steps unless the peer explicitly asks for diagnostic details.",
	)
}

func applyChatPersonaRules(spec *agent.PromptSpec) {
	if spec == nil {
		return
	}
	spec.Rules = append(spec.Rules,
		"Chat like a real person, not a customer-support assistant.",
		"Do not output intent summaries, execution logs, protocol labels, or process reports unless the user explicitly asks for them.",
		"Default to concise conversational replies (normally 1-4 sentences) unless the user asks for detailed structure.",
		"Use first-person natural wording and follow the persona in IDENTITY.md and SOUL.md.",
		"Avoid corporate phrasing and checklist-style phrasing unless the user explicitly requests formal style.",
	)
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

func updateTelegramMemory(ctx context.Context, logger *slog.Logger, client llm.Client, model string, mgr *memory.Manager, id memory.Identity, job telegramJob, history []chathistory.ChatHistoryItem, historyCap int, final *agent.Final, requestTimeout time.Duration) error {
	if mgr == nil || client == nil {
		return nil
	}
	output := formatFinalOutput(final)
	date := time.Now().UTC()
	contactNickname := strings.TrimSpace(job.FromDisplayName)
	if contactNickname == "" {
		contactNickname = strings.TrimSpace(strings.Join([]string{job.FromFirstName, job.FromLastName}, " "))
	}
	meta := memory.WriteMeta{
		SessionID:        fmt.Sprintf("tg:%d", job.ChatID),
		ContactIDs:       []string{telegramMemoryContactID(job.FromUsername, job.FromUserID)},
		ContactNicknames: []string{contactNickname},
	}

	ctxInfo := MemoryDraftContext{
		SessionID:          meta.SessionID,
		ChatID:             job.ChatID,
		ChatType:           job.ChatType,
		CounterpartyID:     job.FromUserID,
		CounterpartyName:   strings.TrimSpace(job.FromDisplayName),
		CounterpartyHandle: strings.TrimSpace(job.FromUsername),
		TimestampUTC:       time.Now().UTC().Format(time.RFC3339),
	}
	if ctxInfo.CounterpartyName == "" {
		ctxInfo.CounterpartyName = strings.TrimSpace(strings.Join([]string{job.FromFirstName, job.FromLastName}, " "))
	}
	_, existingContent, hasExisting, err := mgr.LoadShortTerm(date, meta.SessionID)
	if err != nil {
		return err
	}

	memCtx := ctx
	cancel := func() {}
	if requestTimeout > 0 {
		memCtx, cancel = context.WithTimeout(ctx, requestTimeout)
	}
	defer cancel()
	ctxInfo.CounterpartyLabel = buildMemoryCounterpartyLabel(meta, ctxInfo)

	draftHistory := buildTelegramMemoryDraftHistory(history, job, output, date, historyCap)
	draft, err := BuildMemoryDraft(memCtx, client, model, draftHistory, job.Text, output, existingContent, ctxInfo)
	if err != nil {
		return err
	}
	draft.Promote = EnforceLongTermPromotionRules(draft.Promote, nil, job.Text)

	var mergedContent memory.ShortTermContent
	if hasExisting && HasDraftContent(draft) {
		semantic, mergeErr := SemanticMergeShortTerm(memCtx, client, model, existingContent, draft)
		if mergeErr != nil {
			return mergeErr
		}
		mergedContent = semantic
	} else {
		createdAt := date.UTC().Format(entryutil.TimestampLayout)
		mergedContent = memory.MergeShortTerm(existingContent, draft, createdAt)
	}

	_, err = mgr.WriteShortTerm(date, mergedContent, meta)
	if err != nil {
		return err
	}
	if _, err := mgr.UpdateLongTerm(id.SubjectID, draft.Promote); err != nil {
		return err
	}
	if logger != nil {
		logger.Debug("memory_update_ok", "subject_id", id.SubjectID)
	}
	return nil
}

func buildTelegramMemoryDraftHistory(history []chathistory.ChatHistoryItem, job telegramJob, output string, now time.Time, maxItems int) []chathistory.ChatHistoryItem {
	out := append([]chathistory.ChatHistoryItem{}, history...)
	out = append(out, newTelegramInboundHistoryItem(job))
	if strings.TrimSpace(output) != "" {
		out = append(out, newTelegramOutboundAgentHistoryItem(job.ChatID, job.ChatType, output, now, ""))
	}
	if maxItems > 0 && len(out) > maxItems {
		out = out[len(out)-maxItems:]
	}
	return out
}

type MemoryDraftContext struct {
	SessionID          string `json:"session_id,omitempty"`
	ChatID             int64  `json:"chat_id,omitempty"`
	ChatType           string `json:"chat_type,omitempty"`
	CounterpartyID     int64  `json:"counterparty_id,omitempty"`
	CounterpartyName   string `json:"counterparty_name,omitempty"`
	CounterpartyHandle string `json:"counterparty_handle,omitempty"`
	CounterpartyLabel  string `json:"counterparty_label,omitempty"`
	TimestampUTC       string `json:"timestamp_utc,omitempty"`
}

func buildMemoryCounterpartyLabel(meta memory.WriteMeta, ctxInfo MemoryDraftContext) string {
	contactID := firstNonEmptyString(meta.ContactIDs...)
	if contactID == "" {
		contactID = strings.TrimSpace(ctxInfo.CounterpartyHandle)
	}
	nickname := firstNonEmptyString(meta.ContactNicknames...)
	if nickname == "" {
		nickname = strings.TrimSpace(ctxInfo.CounterpartyName)
	}
	if nickname != "" && contactID != "" {
		if strings.EqualFold(nickname, contactID) {
			return nickname
		}
		return nickname + "(" + contactID + ")"
	}
	if nickname != "" {
		return nickname
	}
	return contactID
}

func firstNonEmptyString(values ...string) string {
	for _, raw := range values {
		v := strings.TrimSpace(raw)
		if v != "" {
			return v
		}
	}
	return ""
}

func BuildMemoryDraft(ctx context.Context, client llm.Client, model string, history []chathistory.ChatHistoryItem, task string, output string, existing memory.ShortTermContent, ctxInfo MemoryDraftContext) (memory.SessionDraft, error) {
	if client == nil {
		return memory.SessionDraft{}, fmt.Errorf("nil llm client")
	}

	sys, user, err := renderMemoryDraftPrompts(ctxInfo, history, task, output, existing)
	if err != nil {
		return memory.SessionDraft{}, fmt.Errorf("render memory draft prompts: %w", err)
	}

	res, err := client.Chat(llminspect.WithModelScene(ctx, "memory.draft"), llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: sys},
			{Role: "user", Content: user},
		},
		Parameters: map[string]any{
			"max_tokens": 10240,
		},
	})
	if err != nil {
		return memory.SessionDraft{}, err
	}

	raw := strings.TrimSpace(res.Text)
	if raw == "" {
		return memory.SessionDraft{}, fmt.Errorf("empty memory draft response")
	}

	var out memory.SessionDraft
	if err := jsonutil.DecodeWithFallback(raw, &out); err != nil {
		return memory.SessionDraft{}, fmt.Errorf("invalid memory draft json")
	}
	out.SummaryItems = normalizeMemorySummaryItems(out.SummaryItems)
	return out, nil
}

func EnforceLongTermPromotionRules(promote memory.PromoteDraft, history []llm.Message, task string) memory.PromoteDraft {
	if !hasExplicitMemoryRequest(history, task) {
		return memory.PromoteDraft{}
	}
	return limitPromoteToOne(promote)
}

func hasExplicitMemoryRequest(history []llm.Message, task string) bool {
	texts := make([]string, 0, len(history)+1)
	for _, m := range history {
		if strings.ToLower(strings.TrimSpace(m.Role)) != "user" {
			continue
		}
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		texts = append(texts, content)
	}
	if strings.TrimSpace(task) != "" {
		texts = append(texts, task)
	}
	if len(texts) == 0 {
		return false
	}
	combined := strings.ToLower(strings.Join(texts, "\n"))
	return containsExplicitMemoryRequest(combined)
}

func containsExplicitMemoryRequest(lowerText string) bool {
	if strings.TrimSpace(lowerText) == "" {
		return false
	}
	keywords := []string{
		"记住",
		"记下来",
		"别忘",
		"记得",
		"长期记忆",
		"写入长期记忆",
		"加入长期记忆",
		"记到长期",
		"remember",
		"don't forget",
		"dont forget",
		"long-term memory",
		"add to memory",
		"save this",
		"keep this",
		"store this",
		"memorize",
	}
	for _, k := range keywords {
		if strings.Contains(lowerText, k) {
			return true
		}
	}
	return false
}

func limitPromoteToOne(promote memory.PromoteDraft) memory.PromoteDraft {
	if item, ok := firstNonEmptyText(promote.GoalsProjects); ok {
		return memory.PromoteDraft{GoalsProjects: []string{item}}
	}
	if item, ok := firstKVItem(promote.KeyFacts); ok {
		return memory.PromoteDraft{KeyFacts: []memory.KVItem{item}}
	}
	return memory.PromoteDraft{}
}

func firstNonEmptyText(items []string) (string, bool) {
	for _, raw := range items {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		return v, true
	}
	return "", false
}

func firstKVItem(items []memory.KVItem) (memory.KVItem, bool) {
	for _, it := range items {
		title := strings.TrimSpace(it.Title)
		value := strings.TrimSpace(it.Value)
		if title == "" && value == "" {
			continue
		}
		it.Title = title
		it.Value = value
		return it, true
	}
	return memory.KVItem{}, false
}

func SemanticMergeShortTerm(ctx context.Context, client llm.Client, model string, existing memory.ShortTermContent, draft memory.SessionDraft) (memory.ShortTermContent, error) {
	if client == nil {
		return memory.ShortTermContent{}, fmt.Errorf("nil llm client")
	}
	incoming := memory.MergeShortTerm(memory.ShortTermContent{}, draft, time.Now().UTC().Format(entryutil.TimestampLayout))
	if len(incoming.SummaryItems) == 0 {
		return memory.NormalizeShortTermContent(existing), nil
	}
	combined := make([]memory.SummaryItem, 0, len(incoming.SummaryItems)+len(existing.SummaryItems))
	combined = append(combined, incoming.SummaryItems...)
	combined = append(combined, existing.SummaryItems...)

	resolver := entryutil.NewLLMSemanticResolver(client, model)
	deduped, err := memory.SemanticDedupeSummaryItems(llminspect.WithModelScene(ctx, "memory.semantic_dedupe"), combined, resolver)
	if err != nil {
		return memory.ShortTermContent{}, err
	}

	merged := memory.NormalizeShortTermContent(memory.ShortTermContent{SummaryItems: deduped})
	return merged, nil
}

func HasDraftContent(draft memory.SessionDraft) bool {
	return len(normalizeMemorySummaryItems(draft.SummaryItems)) > 0
}

func normalizeMemorySummaryItems(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	out := make([]string, 0, len(input))
	seen := make(map[string]bool, len(input))
	for _, raw := range input {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		key := strings.ToLower(v)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// Telegram API

type telegramAPI struct {
	http    *http.Client
	baseURL string
	token   string
}

func newTelegramAPI(httpClient *http.Client, baseURL, token string) *telegramAPI {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &telegramAPI{
		http:    httpClient,
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
	}
}

type telegramUpdate struct {
	UpdateID int64            `json:"update_id"`
	Message  *telegramMessage `json:"message,omitempty"`
	// Some clients/users may @mention by editing an existing message.
	EditedMessage     *telegramMessage `json:"edited_message,omitempty"`
	ChannelPost       *telegramMessage `json:"channel_post,omitempty"`
	EditedChannelPost *telegramMessage `json:"edited_channel_post,omitempty"`
}

type telegramMessage struct {
	MessageID int64            `json:"message_id"`
	Date      int64            `json:"date,omitempty"`
	Chat      *telegramChat    `json:"chat,omitempty"`
	From      *telegramUser    `json:"from,omitempty"`
	ReplyTo   *telegramMessage `json:"reply_to_message,omitempty"`
	Entities  []telegramEntity `json:"entities,omitempty"`
	Text      string           `json:"text,omitempty"`
	Caption   string           `json:"caption,omitempty"`
	// Entities inside caption text.
	CaptionEntities []telegramEntity `json:"caption_entities,omitempty"`

	// Attachments (subset).
	Document *telegramDocument   `json:"document,omitempty"`
	Photo    []telegramPhotoSize `json:"photo,omitempty"`
}

type telegramChat struct {
	ID   int64  `json:"id"`
	Type string `json:"type,omitempty"` // private|group|supergroup|channel
}

type telegramUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot,omitempty"`
	Username  string `json:"username,omitempty"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
}

func telegramDisplayName(u *telegramUser) string {
	if u == nil {
		return ""
	}
	first := strings.TrimSpace(u.FirstName)
	last := strings.TrimSpace(u.LastName)
	username := strings.TrimSpace(u.Username)
	switch {
	case first != "" && last != "":
		return first + " " + last
	case first != "":
		return first
	case last != "":
		return last
	case username != "":
		return "@" + username
	default:
		return ""
	}
}

type telegramEntity struct {
	Type   string        `json:"type"`
	Offset int           `json:"offset"`
	Length int           `json:"length"`
	User   *telegramUser `json:"user,omitempty"` // for text_mention
}

type telegramDocument struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramPhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramGetUpdatesResponse struct {
	OK     bool             `json:"ok"`
	Result []telegramUpdate `json:"result"`
}

type telegramGetMeResponse struct {
	OK     bool         `json:"ok"`
	Result telegramUser `json:"result"`
}

func (api *telegramAPI) getMe(ctx context.Context) (*telegramUser, error) {
	url := fmt.Sprintf("%s/bot%s/getMe", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := api.http.Do(req)
	if err != nil {
		return nil, err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out telegramGetMeResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, fmt.Errorf("telegram getMe: ok=false")
	}
	return &out.Result, nil
}

func (api *telegramAPI) getUpdates(ctx context.Context, offset int64, timeout time.Duration) ([]telegramUpdate, int64, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	secs := int(timeout.Seconds())
	if secs < 1 {
		secs = 1
	}
	url := fmt.Sprintf("%s/bot%s/getUpdates?timeout=%d", api.baseURL, api.token, secs)
	if offset > 0 {
		url += fmt.Sprintf("&offset=%d", offset)
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, offset, err
	}
	resp, err := api.http.Do(req)
	if err != nil {
		return nil, offset, err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, offset, fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var out telegramGetUpdatesResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, offset, err
	}
	if !out.OK {
		return nil, offset, fmt.Errorf("telegram getUpdates: ok=false")
	}

	next := offset
	for _, u := range out.Result {
		if u.UpdateID >= next {
			next = u.UpdateID + 1
		}
	}
	return out.Result, next, nil
}

func isTelegramPollTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(msg, "context deadline exceeded") ||
		strings.Contains(msg, "client.timeout exceeded")
}

type telegramSendMessageRequest struct {
	ChatID                int64  `json:"chat_id"`
	Text                  string `json:"text"`
	ParseMode             string `json:"parse_mode,omitempty"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview,omitempty"`
	ReplyToMessageID      int64  `json:"reply_to_message_id,omitempty"`
}

type telegramSendChatActionRequest struct {
	ChatID int64  `json:"chat_id"`
	Action string `json:"action"`
}

type telegramReactionType struct {
	Type          string `json:"type"`
	Emoji         string `json:"emoji,omitempty"`
	CustomEmojiID string `json:"custom_emoji_id,omitempty"`
}

type telegramSetMessageReactionRequest struct {
	ChatID    int64                  `json:"chat_id"`
	MessageID int64                  `json:"message_id"`
	Reaction  []telegramReactionType `json:"reaction,omitempty"`
	IsBig     *bool                  `json:"is_big,omitempty"`
}

type telegramOKResponse struct {
	OK          bool   `json:"ok"`
	ErrorCode   int    `json:"error_code,omitempty"`
	Description string `json:"description,omitempty"`
}

type telegramFile struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id,omitempty"`
	FileSize     int64  `json:"file_size,omitempty"`
	FilePath     string `json:"file_path,omitempty"`
}

type telegramGetFileResponse struct {
	OK     bool         `json:"ok"`
	Result telegramFile `json:"result"`
}

func (api *telegramAPI) getFile(ctx context.Context, fileID string) (*telegramFile, error) {
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return nil, fmt.Errorf("missing file_id")
	}
	url := fmt.Sprintf("%s/bot%s/getFile?file_id=%s", api.baseURL, api.token, url.QueryEscape(fileID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := api.http.Do(req)
	if err != nil {
		return nil, err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out telegramGetFileResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, fmt.Errorf("telegram getFile: ok=false")
	}
	if strings.TrimSpace(out.Result.FilePath) == "" {
		return nil, fmt.Errorf("telegram getFile: missing file_path")
	}
	return &out.Result, nil
}

func (api *telegramAPI) downloadFileTo(ctx context.Context, filePath, dstPath string, maxBytes int64) (int64, bool, error) {
	filePath = strings.TrimSpace(filePath)
	dstPath = strings.TrimSpace(dstPath)
	if filePath == "" {
		return 0, false, fmt.Errorf("missing file_path")
	}
	if dstPath == "" {
		return 0, false, fmt.Errorf("missing dst_path")
	}
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}

	url := fmt.Sprintf("%s/file/bot%s/%s", api.baseURL, api.token, strings.TrimLeft(filePath, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, false, err
	}
	resp, err := api.http.Do(req)
	if err != nil {
		return 0, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return 0, false, fmt.Errorf("telegram download http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, false, err
	}
	defer f.Close()

	limited := io.LimitReader(resp.Body, maxBytes+1)
	n, err := io.Copy(f, limited)
	if err != nil {
		return n, false, err
	}
	if n > maxBytes {
		return n, true, fmt.Errorf("telegram file too large (>%d bytes)", maxBytes)
	}
	if err := f.Close(); err != nil {
		return n, false, err
	}
	if err := os.Chmod(dstPath, 0o600); err != nil {
		return n, false, err
	}
	return n, false, nil
}

func (api *telegramAPI) sendMessageMarkdownV2(ctx context.Context, chatID int64, text string, disablePreview bool) error {
	return api.sendMessageMarkdownV2Reply(ctx, chatID, text, disablePreview, 0)
}

func (api *telegramAPI) sendMessageMarkdownV2Reply(ctx context.Context, chatID int64, text string, disablePreview bool, replyToMessageID int64) error {
	text = strings.TrimSpace(text)
	if text == "" {
		text = "(empty)"
	}

	err := api.sendMessageWithParseModeReply(ctx, chatID, text, disablePreview, "MarkdownV2", replyToMessageID)
	if err == nil {
		return nil
	}
	if !isTelegramMarkdownParseError(err) {
		slog.Warn("failed to send with MarkdownV2", "error", err)
		escaped := escapeTelegramMarkdownV2(text)
		err = api.sendMessageWithParseModeReply(ctx, chatID, escaped, disablePreview, "MarkdownV2", replyToMessageID)
		if err == nil {
			return nil
		}
		if !isTelegramMarkdownParseError(err) {
			slog.Warn("again, failed to send escaped with MarkdownV2", "error", err)
		}
	}

	slog.Warn("failed to send with MarkdownV2; fallback to plain text", "error", err)
	return api.sendMessageWithParseModeReply(ctx, chatID, text, disablePreview, "", replyToMessageID)
}

func escapeTelegramMarkdownV2(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	var b strings.Builder
	b.Grow(len(text) * 2)
	for _, r := range text {
		switch r {
		case '\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

type telegramRequestError struct {
	StatusCode  int
	ErrorCode   int
	Description string
	Body        string
}

func (e *telegramRequestError) Error() string {
	if e == nil {
		return "telegram request failed"
	}
	desc := strings.TrimSpace(e.Description)
	if desc != "" {
		if e.StatusCode > 0 {
			return fmt.Sprintf("telegram http %d: %s", e.StatusCode, desc)
		}
		return "telegram: " + desc
	}
	body := strings.TrimSpace(e.Body)
	if e.StatusCode > 0 {
		if body != "" {
			return fmt.Sprintf("telegram http %d: %s", e.StatusCode, body)
		}
		return fmt.Sprintf("telegram http %d", e.StatusCode)
	}
	if body != "" {
		return "telegram: " + body
	}
	return "telegram request failed"
}

func isTelegramMarkdownParseError(err error) bool {
	if err == nil {
		return false
	}
	var reqErr *telegramRequestError
	if errors.As(err, &reqErr) {
		desc := strings.ToLower(strings.TrimSpace(reqErr.Description))
		if strings.Contains(desc, "can't parse entities") || strings.Contains(desc, "can't parse entity") {
			return true
		}
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(msg, "can't parse entities") || strings.Contains(msg, "can't parse entity")
}

func (api *telegramAPI) sendMessageChunked(ctx context.Context, chatID int64, text string) error {
	return api.sendMessageChunkedReply(ctx, chatID, text, 0)
}

func (api *telegramAPI) sendMessageChunkedReply(ctx context.Context, chatID int64, text string, replyToMessageID int64) error {
	const max = 3500
	text = strings.TrimSpace(text)
	if text == "" {
		return api.sendMessageMarkdownV2Reply(ctx, chatID, "(empty)", true, replyToMessageID)
	}
	isFirstChunk := true
	for len(text) > 0 {
		chunk := text
		if len(chunk) > max {
			chunk = chunk[:max]
		}
		chunkReplyTo := int64(0)
		if isFirstChunk {
			chunkReplyTo = replyToMessageID
		}
		if err := api.sendMessageMarkdownV2Reply(ctx, chatID, chunk, true, chunkReplyTo); err != nil {
			return err
		}
		text = strings.TrimSpace(text[len(chunk):])
		isFirstChunk = false
	}
	return nil
}

func (api *telegramAPI) sendMessageWithParseModeReply(ctx context.Context, chatID int64, text string, disablePreview bool, parseMode string, replyToMessageID int64) error {
	reqBody := telegramSendMessageRequest{
		ChatID:                chatID,
		Text:                  text,
		ParseMode:             strings.TrimSpace(parseMode),
		DisableWebPagePreview: disablePreview,
		ReplyToMessageID:      replyToMessageID,
	}
	b, _ := json.Marshal(reqBody)
	url := fmt.Sprintf("%s/bot%s/sendMessage", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var out telegramOKResponse
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &telegramRequestError{
			StatusCode:  resp.StatusCode,
			ErrorCode:   out.ErrorCode,
			Description: out.Description,
			Body:        strings.TrimSpace(string(raw)),
		}
	}
	if !out.OK {
		return &telegramRequestError{
			StatusCode:  resp.StatusCode,
			ErrorCode:   out.ErrorCode,
			Description: out.Description,
			Body:        strings.TrimSpace(string(raw)),
		}
	}
	return nil
}

func (api *telegramAPI) sendDocument(ctx context.Context, chatID int64, filePath string, filename string, caption string) error {
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return fmt.Errorf("missing file path")
	}

	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("path is a directory: %s", filePath)
	}

	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(filePath)
	}
	if filename == "" {
		filename = "file"
	}
	caption = strings.TrimSpace(caption)

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		defer pw.Close()
		defer mw.Close()

		_ = mw.WriteField("chat_id", strconv.FormatInt(chatID, 10))
		if caption != "" {
			_ = mw.WriteField("caption", caption)
		}

		part, err := mw.CreateFormFile("document", filename)
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, f); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
	}()

	url := fmt.Sprintf("%s/bot%s/sendDocument", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var ok telegramOKResponse
	_ = json.Unmarshal(raw, &ok)
	if !ok.OK {
		return fmt.Errorf("telegram sendDocument: ok=false")
	}
	return nil
}

func (api *telegramAPI) sendVoice(ctx context.Context, chatID int64, filePath string, filename string, caption string) error {
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return fmt.Errorf("missing file path")
	}

	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("path is a directory: %s", filePath)
	}

	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(filePath)
	}
	if filename == "" {
		filename = "voice.ogg"
	}
	caption = strings.TrimSpace(caption)

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		defer pw.Close()
		defer mw.Close()

		_ = mw.WriteField("chat_id", strconv.FormatInt(chatID, 10))
		if caption != "" {
			_ = mw.WriteField("caption", caption)
		}

		part, err := mw.CreateFormFile("voice", filename)
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, f); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
	}()

	url := fmt.Sprintf("%s/bot%s/sendVoice", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var ok telegramOKResponse
	_ = json.Unmarshal(raw, &ok)
	if !ok.OK {
		return fmt.Errorf("telegram sendVoice: ok=false")
	}
	return nil
}

func (api *telegramAPI) setMessageReaction(ctx context.Context, chatID int64, messageID int64, reactions []telegramReactionType, isBig *bool) error {
	if messageID == 0 {
		return fmt.Errorf("missing message_id")
	}
	reqBody := telegramSetMessageReactionRequest{
		ChatID:    chatID,
		MessageID: messageID,
		Reaction:  reactions,
		IsBig:     isBig,
	}
	b, _ := json.Marshal(reqBody)

	url := fmt.Sprintf("%s/bot%s/setMessageReaction", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var ok telegramOKResponse
	_ = json.Unmarshal(raw, &ok)
	if !ok.OK {
		return fmt.Errorf("telegram setMessageReaction: ok=false")
	}
	return nil
}

func splitCommand(text string) (cmd string, rest string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", ""
	}
	i := strings.IndexAny(text, " \n\t")
	if i == -1 {
		return text, ""
	}
	return text[:i], strings.TrimSpace(text[i:])
}

func normalizeSlashCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" || !strings.HasPrefix(cmd, "/") {
		return ""
	}
	// Allow "/cmd@BotName" variants by stripping "@...".
	if at := strings.IndexByte(cmd, '@'); at >= 0 {
		cmd = cmd[:at]
	}
	return strings.ToLower(cmd)
}

type telegramGroupTriggerDecision struct {
	Reason            string
	UsedAddressingLLM bool

	AddressingLLMAttempted  bool
	AddressingLLMOK         bool
	AddressingLLMAddressed  bool
	AddressingLLMConfidence float64
	AddressingImpulse       float64
}

func quoteReplyMessageIDForGroupTrigger(msg *telegramMessage, dec telegramGroupTriggerDecision) int64 {
	if msg == nil || msg.MessageID <= 0 {
		return 0
	}
	if dec.AddressingImpulse > 0.8 {
		return msg.MessageID
	}
	return 0
}

// groupTriggerDecision belongs to the trigger layer.
// It decides whether this group message should enter an agent run.
// It must not decide output modality (text reply vs reaction), which is handled in the generation layer.
func groupTriggerDecision(ctx context.Context, client llm.Client, model string, msg *telegramMessage, botUser string, botID int64, aliases []string, mode string, aliasPrefixMaxChars int, addressingLLMTimeout time.Duration, smartAddressingConfidence float64, talkativeAddressingConfidence float64, history []chathistory.ChatHistoryItem) (telegramGroupTriggerDecision, bool, error) {
	if msg == nil {
		return telegramGroupTriggerDecision{}, false, nil
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "smart"
	}
	if smartAddressingConfidence <= 0 {
		smartAddressingConfidence = 0.55
	}
	if smartAddressingConfidence > 1 {
		smartAddressingConfidence = 1
	}
	if talkativeAddressingConfidence <= 0 {
		talkativeAddressingConfidence = 0.55
	}
	if talkativeAddressingConfidence > 1 {
		talkativeAddressingConfidence = 1
	}

	text := strings.TrimSpace(messageTextOrCaption(msg))
	explicitReason, explicitMentioned := groupExplicitMentionReason(msg, text, botUser, botID)
	if explicitMentioned {
		return telegramGroupTriggerDecision{
			Reason:            explicitReason,
			AddressingImpulse: 1,
		}, true, nil
	}

	runAddressingLLM := func(confidenceThreshold float64, fallbackReason string) (telegramGroupTriggerDecision, bool, error) {
		dec := telegramGroupTriggerDecision{
			AddressingLLMAttempted: true,
			Reason:                 strings.TrimSpace(fallbackReason),
		}
		addrCtx := ctx
		if addrCtx == nil {
			addrCtx = context.Background()
		}
		cancel := func() {}
		if addressingLLMTimeout > 0 {
			addrCtx, cancel = context.WithTimeout(addrCtx, addressingLLMTimeout)
		}
		llmDec, llmOK, llmErr := addressingDecisionViaLLM(addrCtx, client, model, botUser, aliases, text, history)
		cancel()
		if llmErr != nil {
			return dec, false, llmErr
		}
		dec.AddressingLLMOK = llmOK
		dec.AddressingLLMAddressed = llmDec.Addressed
		dec.AddressingLLMConfidence = llmDec.Confidence
		dec.AddressingImpulse = llmDec.Impulse
		if strings.TrimSpace(llmDec.Reason) != "" {
			dec.Reason = llmDec.Reason
		}
		if llmOK && llmDec.Addressed && llmDec.Confidence >= confidenceThreshold {
			dec.UsedAddressingLLM = true
			return dec, true, nil
		}
		return dec, false, nil
	}

	switch mode {
	case "talkative":
		return runAddressingLLM(talkativeAddressingConfidence, "talkative")
	case "smart":
		mentionReason, _ := groupAliasMentionReason(text, aliases, aliasPrefixMaxChars)
		if strings.TrimSpace(mentionReason) == "" {
			return telegramGroupTriggerDecision{}, false, nil
		}
		return runAddressingLLM(smartAddressingConfidence, mentionReason)
	default: // strict (and unknown values fallback to strict behavior)
		return telegramGroupTriggerDecision{}, false, nil
	}
}

func groupExplicitMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	// Reply-to-bot.
	if msg != nil && msg.ReplyTo != nil && msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		if text == "" && !messageHasDownloadableFile(msg) {
			return "", false
		}
		return "reply", true
	}
	if text == "" {
		return "", false
	}

	// Entity-based mention of the bot (text_mention includes user id; mention includes "@username").
	if msg != nil {
		for _, e := range msg.Entities {
			switch strings.ToLower(strings.TrimSpace(e.Type)) {
			case "text_mention":
				if e.User != nil && e.User.ID == botID {
					return "text_mention", true
				}
			case "mention":
				if botUser != "" {
					mention := sliceByUTF16(text, e.Offset, e.Length)
					if strings.EqualFold(mention, "@"+botUser) {
						return "mention_entity", true
					}
				}
			}
		}
	}

	// Fallback explicit @mention (some clients may omit entities).
	if botUser != "" && strings.Contains(strings.ToLower(text), "@"+strings.ToLower(botUser)) {
		return "at_mention", true
	}
	return "", false
}

func groupAliasMentionReason(text string, aliases []string, aliasPrefixMaxChars int) (string, bool) {
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	if m, ok := matchAddressedAliasSmart(text, aliases, aliasPrefixMaxChars); ok {
		return "alias_smart:" + m.Alias, true
	}
	if hit, ok := anyAliasContains(text, aliases); ok {
		return "alias_mention:" + hit, true
	}
	return "", false
}

const mentionUserSnapshotLimit = 12

func collectMentionCandidates(msg *telegramMessage, botUser string) []string {
	if msg == nil {
		return nil
	}
	var out []string
	add := func(username string) {
		username = strings.TrimSpace(username)
		if username == "" {
			return
		}
		if strings.HasPrefix(username, "@") {
			username = strings.TrimSpace(username[1:])
		}
		if username == "" {
			return
		}
		if botUser != "" && strings.EqualFold(username, botUser) {
			return
		}
		out = append(out, "@"+username)
	}
	if msg.From != nil && !msg.From.IsBot {
		add(msg.From.Username)
	}
	if msg.ReplyTo != nil && msg.ReplyTo.From != nil && !msg.ReplyTo.From.IsBot {
		add(msg.ReplyTo.From.Username)
	}
	addEntities := func(text string, entities []telegramEntity) {
		if strings.TrimSpace(text) == "" || len(entities) == 0 {
			return
		}
		for _, e := range entities {
			switch strings.ToLower(strings.TrimSpace(e.Type)) {
			case "text_mention":
				if e.User != nil {
					add(e.User.Username)
				}
			case "mention":
				mention := strings.TrimSpace(sliceByUTF16(text, e.Offset, e.Length))
				if mention == "" {
					continue
				}
				add(strings.TrimPrefix(mention, "@"))
			}
		}
	}
	addEntities(msg.Text, msg.Entities)
	addEntities(msg.Caption, msg.CaptionEntities)
	return out
}

func addKnownUsernames(known map[int64]map[string]string, chatID int64, usernames []string) {
	if chatID == 0 || len(usernames) == 0 {
		return
	}
	set := known[chatID]
	if set == nil {
		set = make(map[string]string)
		known[chatID] = set
	}
	for _, username := range usernames {
		username = strings.TrimSpace(username)
		if username == "" {
			continue
		}
		if strings.HasPrefix(username, "@") {
			username = strings.TrimSpace(username[1:])
		}
		if username == "" {
			continue
		}
		key := strings.ToLower(username)
		if _, ok := set[key]; ok {
			continue
		}
		set[key] = "@" + username
	}
}

func mentionUsersSnapshot(known map[string]string, limit int) []string {
	if len(known) == 0 {
		return nil
	}
	out := make([]string, 0, len(known))
	for _, username := range known {
		out = append(out, username)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func isGroupChat(chatType string) bool {
	chatType = strings.ToLower(strings.TrimSpace(chatType))
	return chatType == "group" || chatType == "supergroup"
}

func shouldAutoReplyMAEPTopic(topic string) bool {
	return strings.TrimSpace(topic) != ""
}

func resolveMAEPReplyTopic(inboundTopic string) string {
	switch strings.ToLower(strings.TrimSpace(inboundTopic)) {
	case "dm.checkin.v1":
		return "dm.reply.v1"
	case "chat.message":
		return "chat.message"
	default:
		return "dm.reply.v1"
	}
}

func busErrorCodeString(err error) string {
	if err == nil {
		return ""
	}
	return string(busruntime.ErrorCodeOf(err))
}

func publishTelegramBusOutbound(ctx context.Context, inprocBus *busruntime.Inproc, chatID int64, text string, replyTo string, correlationID string) (string, error) {
	if inprocBus == nil {
		return "", fmt.Errorf("bus is required")
	}
	if ctx == nil {
		return "", fmt.Errorf("context is required")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text is required")
	}
	replyTo = strings.TrimSpace(replyTo)
	now := time.Now().UTC()
	messageID := "msg_" + uuid.NewString()
	sessionUUID, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	sessionID := sessionUUID.String()
	payloadBase64, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: messageID,
		Text:      text,
		SentAt:    now.Format(time.RFC3339),
		SessionID: sessionID,
		ReplyTo:   replyTo,
	})
	if err != nil {
		return "", err
	}
	conversationKey, err := busruntime.BuildTelegramChatConversationKey(strconv.FormatInt(chatID, 10))
	if err != nil {
		return "", err
	}
	correlationID = strings.TrimSpace(correlationID)
	if correlationID == "" {
		correlationID = "telegram:" + messageID
	}
	outbound := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelTelegram,
		Topic:           busruntime.TopicChatMessage,
		ConversationKey: conversationKey,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(messageID),
		CorrelationID:   correlationID,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
		Extensions: busruntime.MessageExtensions{
			SessionID: sessionID,
			ReplyTo:   replyTo,
		},
	}
	if err := inprocBus.PublishValidated(ctx, outbound); err != nil {
		return "", err
	}
	return messageID, nil
}

func publishMAEPBusOutbound(ctx context.Context, inprocBus *busruntime.Inproc, peerID string, topic string, text string, sessionID string, replyTo string, correlationID string) (string, error) {
	if inprocBus == nil {
		return "", fmt.Errorf("bus is required")
	}
	if ctx == nil {
		return "", fmt.Errorf("context is required")
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return "", fmt.Errorf("peer_id is required")
	}
	topic = strings.TrimSpace(topic)
	if topic == "" {
		return "", fmt.Errorf("topic is required")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text is required")
	}
	sessionID = strings.TrimSpace(sessionID)
	replyTo = strings.TrimSpace(replyTo)
	now := time.Now().UTC()
	messageID := "msg_" + uuid.NewString()
	payloadBase64, err := busruntime.EncodeMessageEnvelope(topic, busruntime.MessageEnvelope{
		MessageID: messageID,
		Text:      text,
		SentAt:    now.Format(time.RFC3339),
		SessionID: sessionID,
		ReplyTo:   replyTo,
	})
	if err != nil {
		return "", err
	}
	conversationKey, err := busruntime.BuildMAEPPeerConversationKey(peerID)
	if err != nil {
		return "", err
	}
	correlationID = strings.TrimSpace(correlationID)
	if correlationID == "" {
		correlationID = "maep:" + messageID
	}
	outbound := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  peerID,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(messageID),
		CorrelationID:   correlationID,
		PayloadBase64:   payloadBase64,
		CreatedAt:       now,
		Extensions: busruntime.MessageExtensions{
			SessionID: sessionID,
			ReplyTo:   replyTo,
		},
	}
	if err := inprocBus.PublishValidated(ctx, outbound); err != nil {
		return "", err
	}
	return messageID, nil
}

func extractMAEPTask(event maep.DataPushEvent) (string, string) {
	payload := event.PayloadBytes
	if len(payload) == 0 {
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(event.PayloadBase64))
		if err == nil {
			payload = decoded
		}
	}
	if len(payload) == 0 {
		return "", ""
	}
	contentType := strings.ToLower(strings.TrimSpace(event.ContentType))
	if strings.HasPrefix(contentType, "text/") {
		return strings.TrimSpace(string(payload)), strings.TrimSpace(event.SessionID)
	}
	if strings.HasPrefix(contentType, "application/json") {
		var obj map[string]any
		if err := json.Unmarshal(payload, &obj); err != nil {
			return strings.TrimSpace(string(payload)), ""
		}
		task := ""
		for _, key := range []string{"text", "message", "content", "prompt"} {
			if v, ok := obj[key].(string); ok && strings.TrimSpace(v) != "" {
				task = strings.TrimSpace(v)
				break
			}
		}
		sessionID := ""
		if v, ok := obj["session_id"].(string); ok {
			sessionID = strings.TrimSpace(v)
		}
		if sessionID == "" {
			sessionID = strings.TrimSpace(event.SessionID)
		}
		return task, sessionID
	}
	return "", ""
}

func classifyMAEPFeedback(ctx context.Context, client llm.Client, model string, history []llm.Message, inboundText string) (maepFeedbackClassification, error) {
	feedback := maepFeedbackClassification{
		NextAction: "continue",
		Confidence: 1,
	}
	if client == nil {
		return feedback, nil
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return feedback, nil
	}
	inboundText = strings.TrimSpace(inboundText)
	if inboundText == "" {
		return feedback, nil
	}
	recent := history
	if len(recent) > 8 {
		recent = recent[len(recent)-8:]
	}
	systemPrompt, userPrompt, err := renderMAEPFeedbackPrompts(recent, inboundText)
	if err != nil {
		return feedback, fmt.Errorf("render maep feedback prompts: %w", err)
	}
	res, err := client.Chat(llminspect.WithModelScene(ctx, "maep.feedback_classify"), llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Parameters: map[string]any{
			"temperature": 0,
			"max_tokens":  400,
		},
	})
	if err != nil {
		return feedback, err
	}
	raw := strings.TrimSpace(res.Text)
	if raw == "" {
		return feedback, fmt.Errorf("empty feedback classification")
	}
	if err := jsonutil.DecodeWithFallback(raw, &feedback); err != nil {
		return feedback, err
	}
	return normalizeMAEPFeedback(feedback), nil
}

func normalizeMAEPFeedback(v maepFeedbackClassification) maepFeedbackClassification {
	v.SignalPositive = clampUnit(v.SignalPositive)
	v.SignalNegative = clampUnit(v.SignalNegative)
	v.SignalBored = clampUnit(v.SignalBored)
	v.Confidence = clampUnit(v.Confidence)
	v.NextAction = normalizeMAEPNextAction(v.NextAction)
	if v.NextAction == "" {
		v.NextAction = "continue"
	}
	return v
}

func normalizeMAEPNextAction(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "continue":
		return "continue"
	case "wrap_up":
		return "wrap_up"
	case "switch_topic":
		return "switch_topic"
	default:
		return ""
	}
}

func maepFeedbackTimeout(requestTimeout time.Duration) time.Duration {
	if requestTimeout > 0 {
		timeout := requestTimeout / 3
		if timeout < 3*time.Second {
			timeout = 3 * time.Second
		}
		if timeout > 15*time.Second {
			timeout = 15 * time.Second
		}
		return timeout
	}
	return 5 * time.Second
}

func maepPushTimeout(requestTimeout time.Duration) time.Duration {
	if requestTimeout > 0 {
		return requestTimeout
	}
	return 15 * time.Second
}

func configuredMAEPMaxTurnsPerSession() int {
	v := viper.GetInt("contacts.proactive.max_turns_per_session")
	if v <= 0 {
		return defaultMAEPMaxTurnsPerSession
	}
	return v
}

func configuredMAEPSessionCooldown() time.Duration {
	v := viper.GetDuration("contacts.proactive.session_cooldown")
	if v <= 0 {
		return defaultMAEPSessionCooldown
	}
	return v
}

func maepSessionKey(peerID string, topic string, sessionID string) string {
	p := strings.TrimSpace(peerID)
	if p == "" {
		p = "unknown"
	}
	s := strings.TrimSpace(sessionID)
	if s != "" {
		return p + "::session:" + s
	}
	return p + "::" + maepSessionScopeByTopic(topic)
}

func maepSessionScopeByTopic(topic string) string {
	return maep.SessionScopeByTopic(topic)
}

func cloneMAEPSessionStates(in map[string]maepSessionState) map[string]maepSessionState {
	if len(in) == 0 {
		return map[string]maepSessionState{}
	}
	out := make(map[string]maepSessionState, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func exportMAEPSessionStates(in map[string]maepSessionState) map[string]maepruntime.SessionState {
	if len(in) == 0 {
		return map[string]maepruntime.SessionState{}
	}
	out := make(map[string]maepruntime.SessionState, len(in))
	for key, value := range in {
		out[key] = maepruntime.SessionState{
			TurnCount:         value.TurnCount,
			CooldownUntil:     value.CooldownUntil,
			UpdatedAt:         value.UpdatedAt,
			InterestLevel:     value.InterestLevel,
			LowInterestRounds: value.LowInterestRounds,
			PreferenceSynced:  value.PreferenceSynced,
		}
	}
	return out
}

func restoreMAEPSessionStates(in map[string]maepruntime.SessionState) map[string]maepSessionState {
	if len(in) == 0 {
		return map[string]maepSessionState{}
	}
	out := make(map[string]maepSessionState, len(in))
	for key, value := range in {
		out[key] = maepSessionState{
			TurnCount:         value.TurnCount,
			CooldownUntil:     value.CooldownUntil,
			UpdatedAt:         value.UpdatedAt,
			InterestLevel:     value.InterestLevel,
			LowInterestRounds: value.LowInterestRounds,
			PreferenceSynced:  value.PreferenceSynced,
		}
	}
	return out
}

func applyMAEPFeedback(state maepSessionState, feedback maepFeedbackClassification) maepSessionState {
	state.InterestLevel = clampUnit(state.InterestLevel)
	if state.InterestLevel == 0 {
		state.InterestLevel = defaultMAEPInterestLevel
	}
	feedback = normalizeMAEPFeedback(feedback)
	next := state.InterestLevel + 0.35*feedback.SignalPositive - 0.30*feedback.SignalNegative - 0.10*feedback.SignalBored
	state.InterestLevel = clampUnit(next)
	if state.InterestLevel < maepInterestStopThreshold {
		state.LowInterestRounds++
	} else {
		state.LowInterestRounds = 0
	}
	return state
}

func maybeLimitMAEPSessionByFeedback(now time.Time, state maepSessionState, feedback maepFeedbackClassification, cooldown time.Duration) (maepSessionState, bool, string) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if cooldown <= 0 {
		cooldown = defaultMAEPSessionCooldown
	}
	feedback = normalizeMAEPFeedback(feedback)
	if feedback.NextAction == "wrap_up" && feedback.Confidence >= maepWrapUpConfidenceThreshold {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, true, "feedback_wrap_up"
	}
	if state.LowInterestRounds >= maepInterestLowRoundsLimit {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, true, "feedback_low_interest"
	}
	return state, false, ""
}

func allowMAEPSessionTurn(now time.Time, state maepSessionState, maxTurns int, cooldown time.Duration) (maepSessionState, bool) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if maxTurns <= 0 {
		maxTurns = defaultMAEPMaxTurnsPerSession
	}
	if cooldown <= 0 {
		cooldown = defaultMAEPSessionCooldown
	}

	if !state.CooldownUntil.IsZero() {
		if now.Before(state.CooldownUntil) {
			state.UpdatedAt = now
			return state, false
		}
		state.CooldownUntil = time.Time{}
		state.TurnCount = 0
		state.LowInterestRounds = 0
		state.InterestLevel = defaultMAEPInterestLevel
		state.PreferenceSynced = false
	}

	if state.TurnCount >= maxTurns {
		state.CooldownUntil = now.Add(cooldown)
		state.UpdatedAt = now
		return state, false
	}

	state.InterestLevel = clampUnit(state.InterestLevel)
	if state.InterestLevel == 0 {
		state.InterestLevel = defaultMAEPInterestLevel
	}
	if state.LowInterestRounds < 0 {
		state.LowInterestRounds = 0
	}
	state.UpdatedAt = now
	return state, true
}

func applyMAEPInboundFeedback(
	ctx context.Context,
	contactsSvc *contacts.Service,
	maepSvc *maep.Service,
	peerID string,
	inboundTopic string,
	sessionID string,
	feedback maepFeedbackClassification,
	now time.Time,
) error {
	_ = ctx
	_ = contactsSvc
	_ = maepSvc
	_ = peerID
	_ = inboundTopic
	_ = sessionID
	_ = feedback
	_ = now
	return nil
}

func applyTelegramInboundFeedback(
	ctx context.Context,
	svc *contacts.Service,
	chatID int64,
	chatType string,
	userID int64,
	username string,
	now time.Time,
) error {
	_ = ctx
	_ = svc
	_ = chatID
	_ = chatType
	_ = userID
	_ = username
	_ = now
	return nil
}

func clampUnit(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func telegramMemoryContactID(username string, userID int64) string {
	username = strings.TrimSpace(username)
	username = strings.TrimPrefix(username, "@")
	username = strings.TrimSpace(username)
	if username != "" {
		return "tg:@" + username
	}
	if userID > 0 {
		return fmt.Sprintf("tg:%d", userID)
	}
	return ""
}

func chooseBusinessContactID(nodeID string, peerID string) string {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID != "" {
		return nodeID
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return ""
	}
	return "maep:" + peerID
}

func refreshMAEPPreferencesOnSessionEnd(
	ctx context.Context,
	contactsSvc *contacts.Service,
	maepSvc *maep.Service,
	client llm.Client,
	model string,
	peerID string,
	inboundTopic string,
	sessionID string,
	latestTask string,
	history []llm.Message,
	now time.Time,
	reason string,
) (bool, error) {
	_ = ctx
	_ = contactsSvc
	_ = maepSvc
	_ = client
	_ = model
	_ = peerID
	_ = inboundTopic
	_ = sessionID
	_ = latestTask
	_ = history
	_ = now
	_ = reason
	return false, nil
}

func lookupMAEPBusinessContact(ctx context.Context, maepSvc *maep.Service, contactsSvc *contacts.Service, peerID string) (contacts.Contact, bool, error) {
	if contactsSvc == nil {
		return contacts.Contact{}, false, nil
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return contacts.Contact{}, false, nil
	}
	nodeID := ""
	if maepSvc != nil {
		item, ok, err := maepSvc.GetContactByPeerID(ctx, peerID)
		if err != nil {
			return contacts.Contact{}, false, err
		}
		if ok {
			nodeID = strings.TrimSpace(item.NodeID)
		}
	}
	ids := []string{chooseBusinessContactID(nodeID, peerID), "maep:" + peerID}
	seen := map[string]bool{}
	for _, raw := range ids {
		contactID := strings.TrimSpace(raw)
		if contactID == "" || seen[contactID] {
			continue
		}
		seen[contactID] = true
		contact, ok, err := contactsSvc.GetContact(ctx, contactID)
		if err != nil {
			return contacts.Contact{}, false, err
		}
		if ok {
			return contact, true, nil
		}
	}
	return contacts.Contact{}, false, nil
}

const (
	telegramHistoryCapTalkative = 16
	telegramHistoryCapDefault   = 8
	telegramStickySkillsCap     = 3
)

func telegramHistoryCapForMode(mode string) int {
	if strings.EqualFold(strings.TrimSpace(mode), "talkative") {
		return telegramHistoryCapTalkative
	}
	return telegramHistoryCapDefault
}

func trimChatHistoryItems(items []chathistory.ChatHistoryItem, max int) []chathistory.ChatHistoryItem {
	if max <= 0 || len(items) <= max {
		return items
	}
	return items[len(items)-max:]
}

var telegramAtMentionPattern = regexp.MustCompile(`@[A-Za-z0-9_]{3,64}`)

func formatTelegramPersonReference(nickname string, username string) string {
	username = strings.TrimPrefix(strings.TrimSpace(username), "@")
	nickname = sanitizeTelegramReferenceLabel(nickname)
	if nickname == "" {
		nickname = username
	}
	if nickname == "" {
		return ""
	}
	if username == "" {
		return nickname
	}
	return "[" + nickname + "](tg:@" + username + ")"
}

func sanitizeTelegramReferenceLabel(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return ""
	}
	label = strings.ReplaceAll(label, "[", "")
	label = strings.ReplaceAll(label, "]", "")
	label = strings.ReplaceAll(label, "(", "")
	label = strings.ReplaceAll(label, ")", "")
	label = strings.Join(strings.Fields(label), " ")
	return strings.TrimSpace(label)
}

func formatTelegramAtMentionsForHistory(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	matches := telegramAtMentionPattern.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	out.Grow(len(text) + len(matches)*12)
	last := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if start < last || start < 0 || end > len(text) || start >= end {
			continue
		}
		username := strings.TrimPrefix(text[start:end], "@")
		lower := strings.ToLower(text)
		if start >= 4 && lower[start-4:start] == "tg:@" {
			continue
		}
		out.WriteString(text[last:start])
		ref := formatTelegramPersonReference(username, username)
		if ref == "" {
			out.WriteString(text[start:end])
		} else {
			out.WriteString(ref)
		}
		last = end
	}
	out.WriteString(text[last:])
	return strings.TrimSpace(out.String())
}

func ensureMarkdownBlockquote(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			lines[i] = ">"
			continue
		}
		if strings.HasPrefix(line, ">") {
			lines[i] = line
			continue
		}
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n")
}

func stripMarkdownBlockquote(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, ">") {
			line = strings.TrimSpace(strings.TrimPrefix(line, ">"))
		}
		lines[i] = line
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func extractQuoteSenderRef(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	firstLine := text
	if idx := strings.Index(firstLine, "\n"); idx >= 0 {
		firstLine = firstLine[:idx]
	}
	firstLine = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(firstLine), ">"))
	if firstLine == "" {
		return ""
	}
	end := strings.Index(firstLine, ")")
	if end <= 0 {
		return ""
	}
	candidate := strings.TrimSpace(firstLine[:end+1])
	if strings.HasPrefix(candidate, "[") && strings.Contains(candidate, "](tg:@") {
		return candidate
	}
	return ""
}

func splitTaskQuoteForHistory(task string) (string, *chathistory.ChatHistoryQuote) {
	task = strings.TrimSpace(task)
	if task == "" {
		return "", nil
	}
	const (
		prefix = "Quoted message:\n"
		sep    = "\n\nUser request:\n"
	)
	if !strings.HasPrefix(task, prefix) {
		return task, nil
	}
	rest := strings.TrimPrefix(task, prefix)
	idx := strings.Index(rest, sep)
	if idx < 0 {
		return task, nil
	}
	quoteRaw := strings.TrimSpace(rest[:idx])
	mainText := strings.TrimSpace(rest[idx+len(sep):])
	quoteRaw = formatTelegramAtMentionsForHistory(quoteRaw)
	block := ensureMarkdownBlockquote(quoteRaw)
	if block == "" {
		return mainText, nil
	}
	return mainText, &chathistory.ChatHistoryQuote{
		SenderRef:     extractQuoteSenderRef(block),
		Text:          stripMarkdownBlockquote(block),
		MarkdownBlock: block,
	}
}

func telegramSenderFromJob(job telegramJob) chathistory.ChatHistorySender {
	username := strings.TrimPrefix(strings.TrimSpace(job.FromUsername), "@")
	nickname := strings.TrimSpace(job.FromDisplayName)
	if nickname == "" {
		first := strings.TrimSpace(job.FromFirstName)
		last := strings.TrimSpace(job.FromLastName)
		switch {
		case first != "" && last != "":
			nickname = first + " " + last
		case first != "":
			nickname = first
		case last != "":
			nickname = last
		default:
			nickname = username
		}
	}
	return chathistory.ChatHistorySender{
		UserID:     strconv.FormatInt(job.FromUserID, 10),
		Username:   username,
		Nickname:   nickname,
		DisplayRef: formatTelegramPersonReference(nickname, username),
	}
}

func newTelegramInboundHistoryItem(job telegramJob) chathistory.ChatHistoryItem {
	sentAt := job.SentAt.UTC()
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	}
	text, quote := splitTaskQuoteForHistory(job.Text)
	text = formatTelegramAtMentionsForHistory(text)
	if text == "" {
		text = "(empty)"
	}
	messageID := ""
	if job.MessageID > 0 {
		messageID = strconv.FormatInt(job.MessageID, 10)
	}
	replyToMessageID := ""
	if job.ReplyToMessageID > 0 {
		replyToMessageID = strconv.FormatInt(job.ReplyToMessageID, 10)
	}
	return chathistory.ChatHistoryItem{
		Channel:          chathistory.ChannelTelegram,
		Kind:             chathistory.KindInboundUser,
		ChatID:           strconv.FormatInt(job.ChatID, 10),
		ChatType:         strings.TrimSpace(job.ChatType),
		MessageID:        messageID,
		ReplyToMessageID: replyToMessageID,
		SentAt:           sentAt,
		Sender:           telegramSenderFromJob(job),
		Text:             text,
		Quote:            quote,
	}
}

func newTelegramOutboundAgentHistoryItem(chatID int64, chatType string, text string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	}
	botUser = strings.TrimPrefix(strings.TrimSpace(botUser), "@")
	nickname := botUser
	if nickname == "" {
		nickname = "MisterMorph"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = "(empty)"
	}
	return chathistory.ChatHistoryItem{
		Channel:  chathistory.ChannelTelegram,
		Kind:     chathistory.KindOutboundAgent,
		ChatID:   strconv.FormatInt(chatID, 10),
		ChatType: strings.TrimSpace(chatType),
		SentAt:   sentAt.UTC(),
		Sender: chathistory.ChatHistorySender{
			Username:   botUser,
			Nickname:   nickname,
			IsBot:      true,
			DisplayRef: formatTelegramPersonReference(nickname, botUser),
		},
		Text: text,
	}
}

func newTelegramOutboundReactionHistoryItem(chatID int64, chatType string, note string, emoji string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	item := newTelegramOutboundAgentHistoryItem(chatID, chatType, note, sentAt, botUser)
	item.Kind = chathistory.KindOutboundReaction
	if strings.TrimSpace(emoji) != "" {
		item.Text = strings.TrimSpace(note)
	}
	return item
}

func newTelegramSystemHistoryItem(chatID int64, chatType string, text string, sentAt time.Time, botUser string) chathistory.ChatHistoryItem {
	item := newTelegramOutboundAgentHistoryItem(chatID, chatType, text, sentAt, botUser)
	item.Kind = chathistory.KindSystem
	return item
}

func collectMAEPUserUtterances(history []llm.Message, latestTask string) []string {
	values := make([]string, 0, len(history)+1)
	for _, msg := range history {
		if strings.ToLower(strings.TrimSpace(msg.Role)) != "user" {
			continue
		}
		text := strings.TrimSpace(msg.Content)
		if text == "" {
			continue
		}
		values = append(values, text)
	}
	if text := strings.TrimSpace(latestTask); text != "" {
		values = append(values, text)
	}
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		text := strings.TrimSpace(raw)
		if text == "" {
			continue
		}
		out = append(out, text)
	}
	return out
}

func dedupeNonEmptyStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func stripBotMentions(text, botUser string) string {
	text = strings.TrimSpace(text)
	if text == "" || botUser == "" {
		return text
	}
	mention := "@" + botUser
	// Remove common mention patterns (case-insensitive).
	lower := strings.ToLower(text)
	idx := strings.Index(lower, strings.ToLower(mention))
	if idx >= 0 {
		text = strings.TrimSpace(text[:idx] + text[idx+len(mention):])
	}
	return strings.TrimSpace(text)
}

func truncateOneLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return `""`
	}
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	s = strings.Join(strings.Fields(s), " ")
	if max <= 0 || len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

func buildReplyContext(msg *telegramMessage) string {
	if msg == nil {
		return ""
	}
	text := strings.TrimSpace(messageTextOrCaption(msg))
	if text == "" && messageHasDownloadableFile(msg) {
		text = "[attachment]"
	}
	if text == "" {
		return ""
	}
	text = truncateRunes(text, 2000)
	if msg.From != nil && strings.TrimSpace(msg.From.Username) != "" {
		return "@" + strings.TrimSpace(msg.From.Username) + ": " + text
	}
	return text
}

func truncateRunes(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" || max <= 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 3 {
		return string(runes[:max])
	}
	return string(runes[:max-3]) + "..."
}

type telegramAliasSmartMatch struct {
	Alias    string
	TaskText string
}

func matchAddressedAliasSmart(text string, aliases []string, aliasPrefixMaxChars int) (telegramAliasSmartMatch, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return telegramAliasSmartMatch{}, false
	}
	if aliasPrefixMaxChars <= 0 {
		aliasPrefixMaxChars = 24
	}

	prefixStart := skipLeadingAddressingJunk(text)

	bestIdx := -1
	best := telegramAliasSmartMatch{}

	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}

		searchFrom := 0
		for {
			idx := indexOfAlias(text, alias, searchFrom)
			if idx < 0 {
				break
			}
			searchFrom = idx + 1

			if idx < prefixStart {
				continue
			}
			if !isAliasAddressingCandidate(text, prefixStart, idx, aliasPrefixMaxChars) {
				continue
			}

			after := idx + len(alias)
			if after < 0 || after > len(text) {
				continue
			}
			rest := trimLeadingSeparators(text[after:])
			if rest == "" {
				continue
			}
			if !looksLikeRequest(rest) {
				continue
			}

			if bestIdx < 0 || idx < bestIdx {
				bestIdx = idx
				best = telegramAliasSmartMatch{Alias: alias, TaskText: rest}
			}
		}
	}

	if bestIdx < 0 {
		return telegramAliasSmartMatch{}, false
	}
	return best, true
}

func anyAliasContains(text string, aliases []string) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}
		if indexOfAlias(text, alias, 0) >= 0 {
			return alias, true
		}
	}
	return "", false
}

func isAliasAddressingCandidate(text string, prefixStart int, aliasIdx int, aliasPrefixMaxChars int) bool {
	if aliasIdx < 0 || aliasIdx > len(text) {
		return false
	}
	if prefixStart < 0 {
		prefixStart = 0
	}
	if prefixStart > aliasIdx {
		return false
	}

	prefix := text[prefixStart:aliasIdx]
	if aliasPrefixMaxChars > 0 && utf8.RuneCountInString(prefix) > aliasPrefixMaxChars {
		return false
	}

	prefixTrim := strings.TrimSpace(prefix)
	if prefixTrim == "" {
		return true
	}
	return looksLikeGreeting(prefixTrim)
}

func looksLikeGreeting(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	s = strings.ToLower(s)
	s = strings.Trim(s, " \t\r\n,.;:!?，。！？：；、-—()[]{}<>\"'")
	switch s {
	case "hi", "hey", "yo", "hello", "sup", "hola", "bonjour", "ciao", "嗨", "你好", "哈喽", "喂":
		return true
	default:
		return false
	}
}

func looksLikeRequest(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	if strings.ContainsAny(s, "？?") {
		return true
	}

	lower := strings.ToLower(s)
	for _, p := range []string{
		"please", "pls", "plz",
		"help", "can you", "could you", "would you",
		"tell me", "explain", "summarize", "translate", "write",
		"generate", "make", "create", "list", "show",
		"why", "how", "what",
	} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}

	for _, p := range []string{
		"请", "麻烦", "帮", "帮我", "能不能", "可以", "能否",
		"给我", "告诉我", "解释", "总结", "列出", "写", "生成", "翻译",
		"查", "看", "做", "分析", "推荐", "对比",
		"为什么", "怎么", "如何", "是什么",
	} {
		if strings.HasPrefix(s, p) || strings.Contains(s, p) {
			return true
		}
	}

	return false
}

func trimLeadingSeparators(s string) string {
	s = strings.TrimSpace(s)
	for s != "" {
		r, size := utf8.DecodeRuneInString(s)
		if r == utf8.RuneError && size == 1 {
			break
		}
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			s = strings.TrimSpace(s[size:])
			continue
		}
		break
	}
	return strings.TrimSpace(s)
}

func skipLeadingAddressingJunk(s string) int {
	i := 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			return i
		}
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			i += size
			continue
		}
		break
	}
	return i
}

func sliceByUTF16(s string, offset, length int) string {
	if offset < 0 {
		offset = 0
	}
	if length <= 0 || s == "" {
		return ""
	}
	start := utf16OffsetToByteIndex(s, offset)
	end := utf16OffsetToByteIndex(s, offset+length)
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	if start > end {
		return ""
	}
	return s[start:end]
}

func utf16OffsetToByteIndex(s string, offset int) int {
	if offset <= 0 {
		return 0
	}
	utf16Count := 0
	for i, r := range s {
		if utf16Count >= offset {
			return i
		}
		if r <= 0xFFFF {
			utf16Count++
		} else {
			utf16Count += 2
		}
	}
	return len(s)
}

func indexOfAlias(text, alias string, start int) int {
	if start < 0 {
		start = 0
	}
	if start >= len(text) {
		return -1
	}
	if alias == "" {
		return -1
	}
	if isASCII(alias) {
		return indexFoldASCII(text, alias, start)
	}
	if i := strings.Index(text[start:], alias); i >= 0 {
		return start + i
	}
	return -1
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func indexFoldASCII(text, sub string, start int) int {
	if start < 0 {
		start = 0
	}
	if len(sub) == 0 {
		return -1
	}
	if start+len(sub) > len(text) {
		return -1
	}

	needle := make([]byte, len(sub))
	for i := 0; i < len(sub); i++ {
		needle[i] = lowerASCII(sub[i])
	}

	hay := []byte(text)
	for i := start; i+len(needle) <= len(hay); i++ {
		ok := true
		for j := 0; j < len(needle); j++ {
			if lowerASCII(hay[i+j]) != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

func lowerASCII(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

type telegramAddressingLLMDecision struct {
	Addressed  bool    `json:"addressed"`
	Confidence float64 `json:"confidence"`
	Impulse    float64 `json:"impulse"`
	Reason     string  `json:"reason"`
}

func addressingDecisionViaLLM(ctx context.Context, client llm.Client, model string, botUser string, aliases []string, text string, history []chathistory.ChatHistoryItem) (telegramAddressingLLMDecision, bool, error) {
	if ctx == nil || client == nil {
		return telegramAddressingLLMDecision{}, false, nil
	}
	text = strings.TrimSpace(text)
	model = strings.TrimSpace(model)
	if model == "" {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("missing model for addressing_llm")
	}

	historyPayload := chathistory.BuildContextPayload(chathistory.ChannelTelegram, history)
	sys, user, err := renderTelegramAddressingPrompts(botUser, aliases, text, historyPayload)
	if err != nil {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}

	res, err := client.Chat(llminspect.WithModelScene(ctx, "telegram.addressing_decision"), llm.Request{
		Model:     model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: sys},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return telegramAddressingLLMDecision{}, false, err
	}

	raw := strings.TrimSpace(res.Text)
	if raw == "" {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("empty addressing_llm response")
	}

	var out telegramAddressingLLMDecision
	if err := jsonutil.DecodeWithFallback(raw, &out); err != nil {
		return telegramAddressingLLMDecision{}, false, fmt.Errorf("invalid addressing_llm json")
	}

	if out.Confidence < 0 {
		out.Confidence = 0
	}
	if out.Confidence > 1 {
		out.Confidence = 1
	}
	if out.Impulse < 0 {
		out.Impulse = 0
	}
	if out.Impulse > 1 {
		out.Impulse = 1
	}
	out.Reason = strings.TrimSpace(out.Reason)
	return out, true, nil
}

func (api *telegramAPI) sendChatAction(ctx context.Context, chatID int64, action string) error {
	action = strings.TrimSpace(action)
	if action == "" {
		action = "typing"
	}
	reqBody := telegramSendChatActionRequest{ChatID: chatID, Action: action}
	b, _ := json.Marshal(reqBody)
	url := fmt.Sprintf("%s/bot%s/sendChatAction", api.baseURL, api.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := api.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func startTypingTicker(ctx context.Context, api *telegramAPI, chatID int64, action string, interval time.Duration) func() {
	if ctx == nil {
		ctx = context.Background()
	}
	if api == nil || chatID == 0 {
		return func() {}
	}
	if interval <= 0 {
		interval = 4 * time.Second
	}
	action = strings.TrimSpace(action)
	if action == "" {
		action = "typing"
	}

	ticker := time.NewTicker(interval)
	done := make(chan struct{})

	go func() {
		_ = api.sendChatAction(ctx, chatID, action)
		for {
			select {
			case <-ticker.C:
				_ = api.sendChatAction(ctx, chatID, action)
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	return func() {
		select {
		case <-done:
		default:
			close(done)
		}
		ticker.Stop()
	}
}

type telegramDownloadedFile struct {
	Kind         string
	OriginalName string
	MimeType     string
	SizeBytes    int64
	Path         string
}

func messageTextOrCaption(msg *telegramMessage) string {
	if msg == nil {
		return ""
	}
	if strings.TrimSpace(msg.Text) != "" {
		return msg.Text
	}
	return msg.Caption
}

func telegramMessageSentAt(msg *telegramMessage) time.Time {
	if msg != nil && msg.Date > 0 {
		return time.Unix(msg.Date, 0).UTC()
	}
	return time.Now().UTC()
}

func messageHasDownloadableFile(msg *telegramMessage) bool {
	if msg == nil {
		return false
	}
	if msg.Document != nil && strings.TrimSpace(msg.Document.FileID) != "" {
		return true
	}
	if len(msg.Photo) > 0 {
		for _, p := range msg.Photo {
			if strings.TrimSpace(p.FileID) != "" {
				return true
			}
		}
	}
	return false
}

func ensureSecureChildDir(parentDir, childDir string) error {
	parentDir = strings.TrimSpace(parentDir)
	childDir = strings.TrimSpace(childDir)
	if parentDir == "" || childDir == "" {
		return fmt.Errorf("missing parent/child dir")
	}
	parentAbs, err := filepath.Abs(parentDir)
	if err != nil {
		return err
	}
	childAbs, err := filepath.Abs(childDir)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(parentAbs, childAbs)
	if err != nil {
		return err
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("child dir is not under parent dir: %s", childAbs)
	}
	return telegramutil.EnsureSecureCacheDir(childAbs)
}

func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "file"
	}
	name = filepath.Base(name)
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '_' || r == '-' || r == '+':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "._- ")
	if out == "" {
		return "file"
	}
	const max = 120
	if len(out) > max {
		out = out[:max]
	}
	return out
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:6])
}

func capUniqueStrings(in []string, max int) []string {
	if len(in) == 0 || max == 0 {
		return nil
	}
	if max < 0 {
		max = 0
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		k := strings.ToLower(v)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
		if max > 0 && len(out) >= max {
			break
		}
	}
	return out
}

func appendDownloadedFilesToTask(task string, files []telegramDownloadedFile) string {
	task = strings.TrimSpace(task)
	var b strings.Builder
	b.WriteString(task)
	if b.Len() > 0 {
		b.WriteString("\n\n")
	}
	b.WriteString("Downloaded Telegram file(s) (use bash tool to process these paths):\n")
	for _, f := range files {
		name := strings.TrimSpace(f.OriginalName)
		if name == "" {
			name = "file"
		}
		b.WriteString("- ")
		if strings.TrimSpace(f.Kind) != "" {
			b.WriteString(strings.TrimSpace(f.Kind))
			b.WriteString(": ")
		}
		b.WriteString(name)
		if strings.TrimSpace(f.Path) != "" {
			b.WriteString(" -> ")
			b.WriteString(strings.TrimSpace(f.Path))
		}
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func downloadTelegramMessageFiles(ctx context.Context, api *telegramAPI, cacheDir string, maxBytes int64, msg *telegramMessage, chatID int64) ([]telegramDownloadedFile, error) {
	if api == nil {
		return nil, fmt.Errorf("telegram api not available")
	}
	if msg == nil {
		return nil, nil
	}
	cacheDir = strings.TrimSpace(cacheDir)
	if cacheDir == "" {
		return nil, fmt.Errorf("missing cache dir")
	}
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}
	if err := telegramutil.EnsureSecureCacheDir(cacheDir); err != nil {
		return nil, err
	}
	chatDir := filepath.Join(cacheDir, fmt.Sprintf("chat_%d", chatID))
	if err := ensureSecureChildDir(cacheDir, chatDir); err != nil {
		return nil, err
	}

	var out []telegramDownloadedFile
	seen := make(map[string]bool)
	handleMessage := func(m *telegramMessage) error {
		if m == nil {
			return nil
		}

		// document
		if m.Document != nil {
			fileID := strings.TrimSpace(m.Document.FileID)
			if fileID != "" {
				key := "doc:" + fileID
				if !seen[key] {
					seen[key] = true
					f, err := api.getFile(ctx, fileID)
					if err != nil {
						return err
					}
					orig := strings.TrimSpace(m.Document.FileName)
					if orig == "" {
						orig = "document" + filepath.Ext(f.FilePath)
					}
					name := sanitizeFilename(orig)
					base := fmt.Sprintf("tg_%d_%s_%s", m.MessageID, shortHash(fileID), name)
					dst := filepath.Join(chatDir, base)
					if _, err := os.Stat(dst); err == nil {
						out = append(out, telegramDownloadedFile{
							Kind:         "document",
							OriginalName: orig,
							MimeType:     m.Document.MimeType,
							SizeBytes:    m.Document.FileSize,
							Path:         dst,
						})
					} else {
						tmp, err := os.CreateTemp(chatDir, base+".tmp-*")
						if err != nil {
							return err
						}
						tmpPath := tmp.Name()
						_ = tmp.Close()
						_, _, dlErr := api.downloadFileTo(ctx, f.FilePath, tmpPath, maxBytes)
						if dlErr != nil {
							_ = os.Remove(tmpPath)
							return dlErr
						}
						if err := os.Chmod(tmpPath, 0o600); err != nil {
							_ = os.Remove(tmpPath)
							return err
						}
						if err := os.Rename(tmpPath, dst); err != nil {
							_ = os.Remove(tmpPath)
							return err
						}
						_ = os.Chmod(dst, 0o600)
						out = append(out, telegramDownloadedFile{
							Kind:         "document",
							OriginalName: orig,
							MimeType:     m.Document.MimeType,
							SizeBytes:    m.Document.FileSize,
							Path:         dst,
						})
					}
				}
			}
		}

		// photo (download the largest size).
		if len(m.Photo) > 0 {
			var best telegramPhotoSize
			for i := range m.Photo {
				if strings.TrimSpace(m.Photo[i].FileID) == "" {
					continue
				}
				best = m.Photo[i]
			}
			if strings.TrimSpace(best.FileID) != "" {
				key := "photo:" + best.FileID
				if !seen[key] {
					seen[key] = true
					f, err := api.getFile(ctx, best.FileID)
					if err != nil {
						return err
					}
					ext := filepath.Ext(f.FilePath)
					orig := "photo" + ext
					name := sanitizeFilename(orig)
					base := fmt.Sprintf("tg_%d_%s_%s", m.MessageID, shortHash(best.FileID), name)
					dst := filepath.Join(chatDir, base)
					if _, err := os.Stat(dst); err == nil {
						out = append(out, telegramDownloadedFile{
							Kind:         "photo",
							OriginalName: orig,
							SizeBytes:    best.FileSize,
							Path:         dst,
						})
					} else {
						tmp, err := os.CreateTemp(chatDir, base+".tmp-*")
						if err != nil {
							return err
						}
						tmpPath := tmp.Name()
						_ = tmp.Close()
						_, _, dlErr := api.downloadFileTo(ctx, f.FilePath, tmpPath, maxBytes)
						if dlErr != nil {
							_ = os.Remove(tmpPath)
							return dlErr
						}
						if err := os.Chmod(tmpPath, 0o600); err != nil {
							_ = os.Remove(tmpPath)
							return err
						}
						if err := os.Rename(tmpPath, dst); err != nil {
							_ = os.Remove(tmpPath)
							return err
						}
						_ = os.Chmod(dst, 0o600)
						out = append(out, telegramDownloadedFile{
							Kind:         "photo",
							OriginalName: orig,
							SizeBytes:    best.FileSize,
							Path:         dst,
						})
					}
				}
			}
		}
		return nil
	}

	if err := handleMessage(msg); err != nil {
		return nil, err
	}
	if msg.ReplyTo != nil {
		if err := handleMessage(msg.ReplyTo); err != nil {
			return nil, err
		}
	}

	return out, nil
}

type telegramSendFileTool struct {
	api      *telegramAPI
	chatID   int64
	cacheDir string
	maxBytes int64
	enabled  bool
}

type telegramSendVoiceTool struct {
	api        *telegramAPI
	defaultTo  int64
	cacheDir   string
	maxBytes   int64
	enabled    bool
	allowedIDs map[int64]bool
}

func newTelegramSendFileTool(api *telegramAPI, chatID int64, cacheDir string, maxBytes int64) *telegramSendFileTool {
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}
	return &telegramSendFileTool{
		api:      api,
		chatID:   chatID,
		cacheDir: strings.TrimSpace(cacheDir),
		maxBytes: maxBytes,
		enabled:  true,
	}
}

func (t *telegramSendFileTool) Name() string { return "telegram_send_file" }

func (t *telegramSendFileTool) Description() string {
	return "Sends a local file (from file_cache_dir) back to the current chat as a document. If you need more advanced behavior, describe it in text instead."
}

func (t *telegramSendFileTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "Path to a local file under file_cache_dir (absolute or relative to that directory).",
			},
			"filename": map[string]any{
				"type":        "string",
				"description": "Optional filename shown to the user (default: basename of path).",
			},
			"caption": map[string]any{
				"type":        "string",
				"description": "Optional caption text.",
			},
		},
		"required": []string{"path"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *telegramSendFileTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.enabled || t.api == nil {
		return "", fmt.Errorf("telegram_send_file is disabled")
	}
	rawPath, _ := params["path"].(string)
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", fmt.Errorf("missing required param: path")
	}
	rawPath = pathutil.NormalizeFileCacheDirPath(rawPath)
	cacheDir := strings.TrimSpace(t.cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}

	p := rawPath
	if !filepath.IsAbs(p) {
		p = filepath.Join(cacheDir, p)
	}
	p = filepath.Clean(p)

	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(cacheAbs, pathAbs)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
		return "", fmt.Errorf("refusing to send file outside file_cache_dir: %s", pathAbs)
	}

	st, err := os.Stat(pathAbs)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", fmt.Errorf("path is a directory: %s", pathAbs)
	}
	if t.maxBytes > 0 && st.Size() > t.maxBytes {
		return "", fmt.Errorf("file too large to send (>%d bytes): %s", t.maxBytes, pathAbs)
	}

	filename, _ := params["filename"].(string)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(pathAbs)
	}
	filename = sanitizeFilename(filename)

	caption, _ := params["caption"].(string)
	caption = strings.TrimSpace(caption)

	if err := t.api.sendDocument(ctx, t.chatID, pathAbs, filename, caption); err != nil {
		return "", err
	}
	return fmt.Sprintf("sent file: %s", filename), nil
}

func newTelegramSendVoiceTool(api *telegramAPI, defaultChatID int64, cacheDir string, maxBytes int64, allowedIDs map[int64]bool) *telegramSendVoiceTool {
	if maxBytes <= 0 {
		maxBytes = 20 * 1024 * 1024
	}
	return &telegramSendVoiceTool{
		api:        api,
		defaultTo:  defaultChatID,
		cacheDir:   strings.TrimSpace(cacheDir),
		maxBytes:   maxBytes,
		enabled:    true,
		allowedIDs: allowedIDs,
	}
}

func (t *telegramSendVoiceTool) Name() string { return "telegram_send_voice" }

func (t *telegramSendVoiceTool) Description() string {
	return "Sends a Telegram voice message. Provide either a local .ogg/.opus file under file_cache_dir, or omit path and provide text to synthesize locally. Use chat_id when not running in an active chat context."
}

func (t *telegramSendVoiceTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"chat_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram chat_id. Optional in interactive chat context; required for scheduled runs unless default chat_id is set.",
			},
			"path": map[string]any{
				"type":        "string",
				"description": "Path to a local voice file under file_cache_dir (absolute or relative to that directory). Recommended: .ogg with Opus audio. If omitted, the tool can synthesize a voice file from `text`.",
			},
			"text": map[string]any{
				"type":        "string",
				"description": "Text to synthesize into a voice message when `path` is omitted. If omitted, falls back to `caption`.",
			},
			"lang": map[string]any{
				"type":        "string",
				"description": "Optional language tag for TTS (BCP-47, e.g., en-US, zh-CN). If omitted, auto-detect.",
			},
			"filename": map[string]any{
				"type":        "string",
				"description": "Optional filename shown to the user (default: basename of path).",
			},
			"caption": map[string]any{
				"type":        "string",
				"description": "Optional caption text.",
			},
		},
		"required": []string{},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

type ttsLang struct {
	Pico   string
	Espeak string
}

func resolveTTSLang(lang string, text string) ttsLang {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		lang = detectLangFromText(text)
	}
	base := strings.ToLower(strings.Split(strings.ReplaceAll(lang, "_", "-"), "-")[0])
	pico := normalizePicoLang(base)
	espeak := normalizeEspeakLang(base)
	if pico == "" && base == "en" {
		pico = "en-US"
	}
	return ttsLang{Pico: pico, Espeak: espeak}
}

func detectLangFromText(text string) string {
	for _, r := range text {
		switch {
		case unicode.In(r, unicode.Han):
			return "zh-CN"
		case unicode.In(r, unicode.Hiragana, unicode.Katakana):
			return "ja-JP"
		case unicode.In(r, unicode.Hangul):
			return "ko-KR"
		case unicode.In(r, unicode.Cyrillic):
			return "ru-RU"
		case unicode.In(r, unicode.Arabic):
			return "ar-SA"
		case unicode.In(r, unicode.Devanagari):
			return "hi-IN"
		}
	}
	return "en-US"
}

func normalizePicoLang(base string) string {
	switch base {
	case "en":
		return "en-US"
	case "de":
		return "de-DE"
	case "es":
		return "es-ES"
	case "fr":
		return "fr-FR"
	case "it":
		return "it-IT"
	default:
		return ""
	}
}

func normalizeEspeakLang(base string) string {
	if base == "" {
		return ""
	}
	return base
}

func selectTTSCmd(ctx context.Context, wavPath string, text string, lang ttsLang) *exec.Cmd {
	if commandExists("pico2wave") && lang.Pico != "" {
		// pico2wave writes the WAV file directly.
		return exec.CommandContext(ctx, "pico2wave", "-l", lang.Pico, "-w", wavPath, text)
	}
	if commandExists("espeak-ng") {
		if lang.Espeak != "" {
			return exec.CommandContext(ctx, "espeak-ng", "-v", lang.Espeak, "-w", wavPath, text)
		}
		return exec.CommandContext(ctx, "espeak-ng", "-w", wavPath, text)
	}
	if commandExists("espeak") {
		if lang.Espeak != "" {
			return exec.CommandContext(ctx, "espeak", "-v", lang.Espeak, "-w", wavPath, text)
		}
		return exec.CommandContext(ctx, "espeak", "-w", wavPath, text)
	}
	if commandExists("flite") {
		return exec.CommandContext(ctx, "flite", "-t", text, "-o", wavPath)
	}
	return nil
}

func synthesizeVoiceToOggOpus(ctx context.Context, cacheDir string, text string) (string, error) {
	return synthesizeVoiceToOggOpusWithLang(ctx, cacheDir, text, "")
}

func synthesizeVoiceToOggOpusWithLang(ctx context.Context, cacheDir string, text string, lang string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("missing voice synthesis text")
	}
	// Keep this bounded: huge TTS is slow and can exceed Telegram limits.
	if len(text) > 1200 {
		text = strings.TrimSpace(text[:1200])
	}

	cacheDir = strings.TrimSpace(cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}
	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	ttsDir := filepath.Join(cacheAbs, "tts")
	if err := os.MkdirAll(ttsDir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(ttsDir, 0o700)

	sum := sha256.Sum256([]byte(text))
	base := fmt.Sprintf("voice_%d_%s", time.Now().UTC().Unix(), hex.EncodeToString(sum[:8]))
	wavPath := filepath.Join(ttsDir, base+".wav")
	oggPath := filepath.Join(ttsDir, base+".ogg")

	ttsLang := resolveTTSLang(lang, text)
	synthCmd := selectTTSCmd(ctx, wavPath, text, ttsLang)
	if synthCmd == nil {
		return "", fmt.Errorf("no local TTS engine found (install one of: pico2wave, espeak-ng, espeak, flite)")
	}
	out, err := synthCmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("tts synth failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	// Convert to OGG/Opus for Telegram voice.
	if commandExists("ffmpeg") {
		conv := exec.CommandContext(ctx, "ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libopus", "-b:a", "24k", "-vbr", "on", "-compression_level", "10", oggPath)
		out, err := conv.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("ffmpeg convert failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	} else if commandExists("opusenc") {
		conv := exec.CommandContext(ctx, "opusenc", "--quiet", wavPath, oggPath)
		out, err := conv.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("opusenc convert failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		return "", fmt.Errorf("no audio converter found (install ffmpeg or opusenc)")
	}

	_ = os.Remove(wavPath)
	_ = os.Chmod(oggPath, 0o600)
	return oggPath, nil
}

func (t *telegramSendVoiceTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.enabled || t.api == nil {
		return "", fmt.Errorf("telegram_send_voice is disabled")
	}

	chatID := t.defaultTo
	if v, ok := params["chat_id"]; ok {
		switch x := v.(type) {
		case int64:
			chatID = x
		case int:
			chatID = int64(x)
		case float64:
			chatID = int64(x)
		}
	}
	if chatID == 0 {
		return "", fmt.Errorf("missing required param: chat_id")
	}
	if len(t.allowedIDs) > 0 && !t.allowedIDs[chatID] {
		return "", fmt.Errorf("unauthorized chat_id: %d", chatID)
	}

	cacheDir := strings.TrimSpace(t.cacheDir)
	if cacheDir == "" {
		return "", fmt.Errorf("file cache dir is not configured")
	}

	cacheAbs, err := filepath.Abs(cacheDir)
	if err != nil {
		return "", err
	}
	caption, _ := params["caption"].(string)
	caption = strings.TrimSpace(caption)

	rawPath, _ := params["path"].(string)
	rawPath = strings.TrimSpace(rawPath)
	rawPath = pathutil.NormalizeFileCacheDirPath(rawPath)

	var pathAbs string
	if rawPath != "" {
		p := rawPath
		if !filepath.IsAbs(p) {
			p = filepath.Join(cacheDir, p)
		}
		p = filepath.Clean(p)

		pathAbs, err = filepath.Abs(p)
		if err != nil {
			return "", err
		}
		rel, err := filepath.Rel(cacheAbs, pathAbs)
		if err != nil {
			return "", err
		}
		if rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
			return "", fmt.Errorf("refusing to send file outside file_cache_dir: %s", pathAbs)
		}

		st, err := os.Stat(pathAbs)
		if err != nil {
			return "", err
		}
		if st.IsDir() {
			return "", fmt.Errorf("path is a directory: %s", pathAbs)
		}
		if t.maxBytes > 0 && st.Size() > t.maxBytes {
			return "", fmt.Errorf("file too large to send (>%d bytes): %s", t.maxBytes, pathAbs)
		}
	} else {
		text, _ := params["text"].(string)
		text = strings.TrimSpace(text)
		if text == "" {
			text = caption
		}
		lang, _ := params["lang"].(string)
		lang = strings.TrimSpace(lang)
		synthCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		pathAbs, err = synthesizeVoiceToOggOpusWithLang(synthCtx, cacheAbs, text, lang)
		if err != nil {
			return "", err
		}
	}

	filename, _ := params["filename"].(string)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(pathAbs)
	}
	filename = sanitizeFilename(filename)

	if err := t.api.sendVoice(ctx, chatID, pathAbs, filename, caption); err != nil {
		return "", err
	}
	return fmt.Sprintf("sent voice: %s", filename), nil
}
