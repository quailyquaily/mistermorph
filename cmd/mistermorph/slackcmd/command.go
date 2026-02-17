package slackcmd

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
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	slackbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/slack"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/healthcheck"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type slackJob struct {
	ConversationKey string
	TeamID          string
	ChannelID       string
	ChatType        string
	MessageTS       string
	ThreadTS        string
	UserID          string
	Text            string
	SentAt          time.Time
	Version         uint64
	MentionUsers    []string
}

type slackConversationWorker struct {
	Jobs    chan slackJob
	Version uint64
}

const slackStickySkillsCap = 16

func newSlackCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "slack",
		Short: "Run a Slack bot with Socket Mode",
		RunE: func(cmd *cobra.Command, args []string) error {
			botToken := strings.TrimSpace(configutil.FlagOrViperString(cmd, "slack-bot-token", "slack.bot_token"))
			if botToken == "" {
				return fmt.Errorf("missing slack.bot_token (set via --slack-bot-token or MISTER_MORPH_SLACK_BOT_TOKEN)")
			}
			viper.Set("slack.bot_token", botToken)
			appToken := strings.TrimSpace(configutil.FlagOrViperString(cmd, "slack-app-token", "slack.app_token"))
			if appToken == "" {
				return fmt.Errorf("missing slack.app_token (set via --slack-app-token or MISTER_MORPH_SLACK_APP_TOKEN)")
			}
			viper.Set("slack.app_token", appToken)

			allowedTeams := toAllowlist(configutil.FlagOrViperStringArray(cmd, "slack-allowed-team-id", "slack.allowed_team_ids"))
			allowedChannels := toAllowlist(configutil.FlagOrViperStringArray(cmd, "slack-allowed-channel-id", "slack.allowed_channel_ids"))

			logger, err := loggerFromViper()
			if err != nil {
				return err
			}
			slog.SetDefault(logger)

			inprocBus, err := busruntime.StartInproc(busruntime.BootstrapOptions{
				MaxInFlight: viper.GetInt("bus.max_inflight"),
				Logger:      logger,
				Component:   "slack",
			})
			if err != nil {
				return err
			}
			defer inprocBus.Close()

			contactsStore := contacts.NewFileStore(statepaths.ContactsDir())
			if err := contactsStore.Ensure(context.Background()); err != nil {
				return err
			}
			contactsSvc := contacts.NewService(contactsStore)
			slackInboundAdapter, err := slackbus.NewInboundAdapter(slackbus.InboundAdapterOptions{
				Bus:   inprocBus,
				Store: contactsStore,
			})
			if err != nil {
				return err
			}

			httpClient := &http.Client{Timeout: 30 * time.Second}
			api := newSlackAPI(httpClient, "https://slack.com/api", botToken, appToken)
			auth, err := api.authTest(cmd.Context())
			if err != nil {
				return fmt.Errorf("slack auth.test: %w", err)
			}
			botUserID := strings.TrimSpace(auth.UserID)
			if botUserID == "" {
				return fmt.Errorf("slack auth.test returned empty user_id")
			}
			if len(allowedTeams) == 0 && strings.TrimSpace(auth.TeamID) != "" {
				allowedTeams[strings.TrimSpace(auth.TeamID)] = true
			}

			slackDeliveryAdapter, err := slackbus.NewDeliveryAdapter(slackbus.DeliveryAdapterOptions{
				SendText: func(ctx context.Context, target any, text string, opts slackbus.SendTextOptions) error {
					deliverTarget, ok := target.(slackbus.DeliveryTarget)
					if !ok {
						return fmt.Errorf("slack target is invalid")
					}
					return api.postMessage(ctx, deliverTarget.ChannelID, text, opts.ThreadTS)
				},
			})
			if err != nil {
				return err
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
					Mode:            "slack",
					Task:            "slack",
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
					Mode:            "slack",
					Task:            "slack",
					TimestampFormat: "20060102_150405",
				})
				if err != nil {
					return err
				}
				defer func() { _ = inspector.Close() }()
				client = &llminspect.PromptClient{Base: client, Inspector: inspector}
			}

			logOpts := logOptionsFromViper()
			reg := registryFromViper()
			if reg == nil {
				reg = tools.NewRegistry()
			}
			registerPlanTool(reg, client, llmModelFromViper())
			toolsutil.BindTodoUpdateToolLLM(reg, client, llmModelFromViper())

			cfg := agent.Config{
				MaxSteps:       viper.GetInt("max_steps"),
				ParseRetries:   viper.GetInt("parse_retries"),
				MaxTokenBudget: viper.GetInt("max_token_budget"),
			}
			taskTimeout := configutil.FlagOrViperDuration(cmd, "slack-task-timeout", "slack.task_timeout")
			if taskTimeout <= 0 {
				taskTimeout = viper.GetDuration("timeout")
			}
			if taskTimeout <= 0 {
				taskTimeout = 10 * time.Minute
			}
			maxConc := configutil.FlagOrViperInt(cmd, "slack-max-concurrency", "slack.max_concurrency")
			if maxConc <= 0 {
				maxConc = 3
			}
			sem := make(chan struct{}, maxConc)

			groupTriggerMode := strings.ToLower(strings.TrimSpace(configutil.FlagOrViperString(cmd, "slack-group-trigger-mode", "slack.group_trigger_mode")))
			if groupTriggerMode == "" {
				groupTriggerMode = "smart"
			}
			addressingLLMTimeout := requestTimeout
			addressingConfidenceThreshold := configutil.FlagOrViperFloat64(cmd, "slack-addressing-confidence-threshold", "slack.addressing_confidence_threshold")
			if addressingConfidenceThreshold <= 0 {
				addressingConfidenceThreshold = 0.6
			}
			if addressingConfidenceThreshold > 1 {
				addressingConfidenceThreshold = 1
			}
			addressingInterjectThreshold := configutil.FlagOrViperFloat64(cmd, "slack-addressing-interject-threshold", "slack.addressing_interject_threshold")
			if addressingInterjectThreshold <= 0 {
				addressingInterjectThreshold = 0.6
			}
			if addressingInterjectThreshold > 1 {
				addressingInterjectThreshold = 1
			}

			healthListen := healthcheck.NormalizeListen(configutil.FlagOrViperString(cmd, "health-listen", "health.listen"))
			if healthListen != "" {
				healthServer, err := healthcheck.StartServer(cmd.Context(), logger, healthListen, "slack")
				if err != nil {
					logger.Warn("slack_health_server_start_error", "addr", healthListen, "error", err.Error())
				} else {
					defer func() {
						shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
						_ = healthServer.Shutdown(shutdownCtx)
						cancel()
					}()
				}
			}

			var (
				mu                  sync.Mutex
				history                          = make(map[string][]chathistory.ChatHistoryItem)
				stickySkillsByConv               = make(map[string][]string)
				workers                          = make(map[string]*slackConversationWorker)
				sharedGuard         *guard.Guard = guardFromViper(logger)
				enqueueSlackInbound func(context.Context, busruntime.BusMessage) error
			)

			getOrStartWorkerLocked := func(conversationKey string) *slackConversationWorker {
				if w, ok := workers[conversationKey]; ok && w != nil {
					return w
				}
				w := &slackConversationWorker{Jobs: make(chan slackJob, 16)}
				workers[conversationKey] = w
				go func(conversationKey string, w *slackConversationWorker) {
					for job := range w.Jobs {
						sem <- struct{}{}
						func() {
							defer func() { <-sem }()
							mu.Lock()
							h := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
							curVersion := w.Version
							sticky := append([]string(nil), stickySkillsByConv[conversationKey]...)
							mu.Unlock()
							if job.Version != curVersion {
								h = nil
							}
							ctx, cancel := context.WithTimeout(context.Background(), taskTimeout)
							final, _, loadedSkills, runErr := runSlackTask(
								ctx,
								logger,
								logOpts,
								client,
								reg,
								sharedGuard,
								cfg,
								llmModelFromViper(),
								job,
								h,
								sticky,
							)
							cancel()

							if runErr != nil {
								_, err := publishSlackBusOutbound(
									context.Background(),
									inprocBus,
									job.TeamID,
									job.ChannelID,
									"error: "+runErr.Error(),
									job.ThreadTS,
									fmt.Sprintf("slack:error:%s:%s", job.ChannelID, job.MessageTS),
								)
								if err != nil {
									logger.Warn("slack_bus_publish_error", "channel", busruntime.ChannelSlack, "channel_id", job.ChannelID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
								}
								return
							}

							outText := strings.TrimSpace(formatFinalOutput(final))
							if outText != "" {
								_, err := publishSlackBusOutbound(
									context.Background(),
									inprocBus,
									job.TeamID,
									job.ChannelID,
									outText,
									job.ThreadTS,
									fmt.Sprintf("slack:message:%s:%s", job.ChannelID, job.MessageTS),
								)
								if err != nil {
									logger.Warn("slack_bus_publish_error", "channel", busruntime.ChannelSlack, "channel_id", job.ChannelID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
								}
							}

							mu.Lock()
							if w.Version != curVersion {
								history[conversationKey] = nil
								stickySkillsByConv[conversationKey] = nil
							}
							if w.Version == curVersion && len(loadedSkills) > 0 {
								stickySkillsByConv[conversationKey] = capUniqueStrings(loadedSkills, slackStickySkillsCap)
							}
							cur := history[conversationKey]
							cur = append(cur, newSlackInboundHistoryItem(job))
							if outText != "" {
								cur = append(cur, newSlackOutboundAgentHistoryItem(job, outText, time.Now().UTC(), botUserID))
							}
							history[conversationKey] = trimChatHistoryItems(cur, slackHistoryCapForMode(groupTriggerMode))
							mu.Unlock()
						}()
					}
				}(conversationKey, w)
				return w
			}

			enqueueSlackInbound = func(ctx context.Context, msg busruntime.BusMessage) error {
				inbound, err := slackbus.InboundMessageFromBusMessage(msg)
				if err != nil {
					return err
				}
				text := strings.TrimSpace(inbound.Text)
				if text == "" {
					return fmt.Errorf("slack inbound text is required")
				}
				mu.Lock()
				w := getOrStartWorkerLocked(msg.ConversationKey)
				v := w.Version
				mu.Unlock()
				job := slackJob{
					ConversationKey: msg.ConversationKey,
					TeamID:          inbound.TeamID,
					ChannelID:       inbound.ChannelID,
					ChatType:        inbound.ChatType,
					MessageTS:       inbound.MessageTS,
					ThreadTS:        inbound.ThreadTS,
					UserID:          inbound.UserID,
					Text:            text,
					SentAt:          inbound.SentAt,
					Version:         v,
					MentionUsers:    append([]string(nil), inbound.MentionUsers...),
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case w.Jobs <- job:
					return nil
				}
			}

			busHandler := func(ctx context.Context, msg busruntime.BusMessage) error {
				switch msg.Direction {
				case busruntime.DirectionInbound:
					if msg.Channel != busruntime.ChannelSlack {
						return fmt.Errorf("unsupported inbound channel: %s", msg.Channel)
					}
					if err := contactsSvc.ObserveInboundBusMessage(context.Background(), msg, nil, time.Now().UTC()); err != nil {
						logger.Warn("contacts_observe_bus_error", "channel", msg.Channel, "idempotency_key", msg.IdempotencyKey, "error", err.Error())
					}
					if enqueueSlackInbound == nil {
						return fmt.Errorf("slack inbound handler is not initialized")
					}
					return enqueueSlackInbound(ctx, msg)
				case busruntime.DirectionOutbound:
					if msg.Channel != busruntime.ChannelSlack {
						return fmt.Errorf("unsupported outbound channel: %s", msg.Channel)
					}
					_, _, err := slackDeliveryAdapter.Deliver(ctx, msg)
					return err
				default:
					return fmt.Errorf("unsupported direction: %s", msg.Direction)
				}
			}
			for _, topic := range busruntime.AllTopics() {
				if err := inprocBus.Subscribe(topic, busHandler); err != nil {
					return err
				}
			}

			appendIgnoredInboundHistory := func(event slackInboundEvent) {
				conversationKey, err := buildSlackConversationKey(event.TeamID, event.ChannelID)
				if err != nil {
					return
				}
				mu.Lock()
				cur := history[conversationKey]
				cur = append(cur, newSlackInboundHistoryItem(slackJob{
					ConversationKey: conversationKey,
					TeamID:          event.TeamID,
					ChannelID:       event.ChannelID,
					ChatType:        event.ChatType,
					MessageTS:       event.MessageTS,
					ThreadTS:        event.ThreadTS,
					UserID:          event.UserID,
					Text:            event.Text,
					SentAt:          event.SentAt,
					MentionUsers:    append([]string(nil), event.MentionUsers...),
				}))
				history[conversationKey] = trimChatHistoryItems(cur, slackHistoryCapForMode(groupTriggerMode))
				mu.Unlock()
			}

			logger.Info("slack_start",
				"bot_user_id", botUserID,
				"allowed_team_ids", len(allowedTeams),
				"allowed_channel_ids", len(allowedChannels),
				"task_timeout", taskTimeout.String(),
				"max_concurrency", maxConc,
				"group_trigger_mode", groupTriggerMode,
				"addressing_confidence_threshold", addressingConfidenceThreshold,
				"addressing_interject_threshold", addressingInterjectThreshold,
			)

			for {
				if cmd.Context().Err() != nil {
					logger.Info("slack_stop", "reason", "context_canceled")
					return nil
				}
				conn, err := api.connectSocket(cmd.Context())
				if err != nil {
					if cmd.Context().Err() != nil {
						logger.Info("slack_stop", "reason", "context_canceled")
						return nil
					}
					logger.Warn("slack_socket_connect_error", "error", err.Error())
					if err := sleepWithContext(cmd.Context(), 2*time.Second); err != nil {
						return nil
					}
					continue
				}
				logger.Info("slack_socket_connected")
				readErr := consumeSlackSocket(cmd.Context(), conn, func(envelope slackSocketEnvelope) error {
					event, ok, err := parseSlackInboundEvent(envelope, botUserID)
					if err != nil {
						return err
					}
					if !ok {
						return nil
					}
					if len(allowedTeams) > 0 && !allowedTeams[event.TeamID] {
						return nil
					}
					if len(allowedChannels) > 0 && !allowedChannels[event.ChannelID] {
						return nil
					}

					isGroup := isSlackGroupChat(event.ChatType)
					if isGroup {
						conversationKey, err := buildSlackConversationKey(event.TeamID, event.ChannelID)
						if err != nil {
							return err
						}
						mu.Lock()
						historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
						mu.Unlock()
						dec, accepted, err := decideSlackGroupTrigger(
							context.Background(),
							client,
							llmModelFromViper(),
							event,
							botUserID,
							groupTriggerMode,
							addressingLLMTimeout,
							addressingConfidenceThreshold,
							addressingInterjectThreshold,
							historySnapshot,
						)
						if err != nil {
							logger.Warn("slack_addressing_llm_error", "channel_id", event.ChannelID, "error", err.Error())
							return nil
						}
						if !accepted {
							if strings.EqualFold(groupTriggerMode, "talkative") {
								appendIgnoredInboundHistory(event)
							}
							return nil
						}
						event.ThreadTS = quoteReplyThreadTSForGroupTrigger(event, dec)
					}

					accepted, err := slackInboundAdapter.HandleInboundMessage(context.Background(), slackbus.InboundMessage{
						TeamID:       event.TeamID,
						ChannelID:    event.ChannelID,
						ChatType:     event.ChatType,
						MessageTS:    event.MessageTS,
						ThreadTS:     event.ThreadTS,
						UserID:       event.UserID,
						Text:         event.Text,
						SentAt:       event.SentAt,
						MentionUsers: append([]string(nil), event.MentionUsers...),
						EventID:      event.EventID,
					})
					if err != nil {
						logger.Warn("slack_bus_publish_error", "channel_id", event.ChannelID, "message_ts", event.MessageTS, "bus_error_code", busErrorCodeString(err), "error", err.Error())
						return nil
					}
					if !accepted {
						logger.Debug("slack_bus_inbound_deduped", "channel_id", event.ChannelID, "message_ts", event.MessageTS)
					}
					return nil
				})
				_ = conn.Close()
				if readErr != nil && !errors.Is(readErr, context.Canceled) && !errors.Is(readErr, context.DeadlineExceeded) {
					logger.Warn("slack_socket_read_error", "error", readErr.Error())
				}
			}
		},
	}

	cmd.Flags().String("slack-bot-token", "", "Slack bot token (xoxb-...).")
	cmd.Flags().String("slack-app-token", "", "Slack app-level token for Socket Mode (xapp-...).")
	cmd.Flags().StringArray("slack-allowed-team-id", nil, "Allowed Slack team id(s). If empty, defaults to the bot's home team.")
	cmd.Flags().StringArray("slack-allowed-channel-id", nil, "Allowed Slack channel id(s). If empty, allows all channels in allowed teams.")
	cmd.Flags().String("slack-group-trigger-mode", "smart", "Group trigger mode: strict|smart|talkative.")
	cmd.Flags().Float64("slack-addressing-confidence-threshold", 0.6, "Minimum confidence (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Float64("slack-addressing-interject-threshold", 0.6, "Minimum interject (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Duration("slack-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("slack-max-concurrency", 3, "Max number of Slack conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_slack_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_slack_YYYYMMDD_HHmmss.md.")

	return cmd
}
