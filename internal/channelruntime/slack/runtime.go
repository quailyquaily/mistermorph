package slack

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
	runtimeworker "github.com/quailyquaily/mistermorph/internal/channelruntime/worker"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/healthcheck"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
)

type RunOptions struct {
	BotToken                      string
	AppToken                      string
	AllowedTeamIDs                []string
	AllowedChannelIDs             []string
	GroupTriggerMode              string
	AddressingConfidenceThreshold float64
	AddressingInterjectThreshold  float64
	TaskTimeout                   time.Duration
	MaxConcurrency                int
	HealthListen                  string
	BaseURL                       string
	BusMaxInFlight                int
	RequestTimeout                time.Duration
	AgentMaxSteps                 int
	AgentParseRetries             int
	AgentMaxTokenBudget           int
	SecretsRequireSkillProfiles   bool
	Hooks                         Hooks
	InspectPrompt                 bool
	InspectRequest                bool
}

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

func Run(ctx context.Context, d Dependencies, opts RunOptions) error {
	return runSlackLoop(ctx, d, resolveRuntimeLoopOptionsFromRunOptions(opts))
}

func runSlackLoop(ctx context.Context, d Dependencies, opts runtimeLoopOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}

	botToken := strings.TrimSpace(opts.BotToken)
	if botToken == "" {
		return fmt.Errorf("missing slack.bot_token")
	}
	appToken := strings.TrimSpace(opts.AppToken)
	if appToken == "" {
		return fmt.Errorf("missing slack.app_token")
	}

	allowedTeams := toAllowlist(opts.AllowedTeamIDs)
	allowedChannels := toAllowlist(opts.AllowedChannelIDs)

	logger, err := loggerFromDeps(d)
	if err != nil {
		return err
	}
	hooks := opts.Hooks
	slog.SetDefault(logger)

	inprocBus, err := busruntime.StartInproc(busruntime.BootstrapOptions{
		MaxInFlight: opts.BusMaxInFlight,
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

	baseURL := strings.TrimSpace(opts.BaseURL)
	httpClient := &http.Client{Timeout: 30 * time.Second}
	api := newSlackAPI(httpClient, baseURL, botToken, appToken)
	auth, err := api.authTest(ctx)
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
	if opts.InspectPrompt {
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

	model := llmModelFromDeps(d)
	logOpts := logOptionsFromDeps(d)
	reg := registryFromDeps(d)
	if reg == nil {
		reg = tools.NewRegistry()
	}
	registerPlanTool(d, reg, client, model)
	toolsutil.BindTodoUpdateToolLLM(reg, client, model)

	cfg := agent.Config{
		MaxSteps:       opts.AgentMaxSteps,
		ParseRetries:   opts.AgentParseRetries,
		MaxTokenBudget: opts.AgentMaxTokenBudget,
	}
	taskRuntimeOpts := runtimeTaskOptions{
		SecretsRequireSkillProfiles: opts.SecretsRequireSkillProfiles,
	}
	taskTimeout := opts.TaskTimeout
	maxConc := opts.MaxConcurrency
	sem := make(chan struct{}, maxConc)

	groupTriggerMode := strings.ToLower(strings.TrimSpace(opts.GroupTriggerMode))
	addressingLLMTimeout := requestTimeout
	addressingConfidenceThreshold := opts.AddressingConfidenceThreshold
	addressingInterjectThreshold := opts.AddressingInterjectThreshold

	healthListen := strings.TrimSpace(opts.HealthListen)
	if healthListen != "" {
		healthServer, err := healthcheck.StartServer(ctx, logger, healthListen, "slack")
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

	workersCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()

	var (
		mu                  sync.Mutex
		history                          = make(map[string][]chathistory.ChatHistoryItem)
		stickySkillsByConv               = make(map[string][]string)
		workers                          = make(map[string]*slackConversationWorker)
		sharedGuard         *guard.Guard = guardFromDeps(d, logger)
		enqueueSlackInbound func(context.Context, busruntime.BusMessage) error
	)

	getOrStartWorkerLocked := func(conversationKey string) *slackConversationWorker {
		if w, ok := workers[conversationKey]; ok && w != nil {
			return w
		}
		w := &slackConversationWorker{Jobs: make(chan slackJob, 16)}
		workers[conversationKey] = w
		runtimeworker.Start(runtimeworker.StartOptions[slackJob]{
			Ctx:  workersCtx,
			Sem:  sem,
			Jobs: w.Jobs,
			Handle: func(workerCtx context.Context, job slackJob) {
				mu.Lock()
				h := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
				curVersion := w.Version
				sticky := append([]string(nil), stickySkillsByConv[conversationKey]...)
				mu.Unlock()
				if job.Version != curVersion {
					h = nil
				}
				runCtx, cancel := context.WithTimeout(workerCtx, taskTimeout)
				final, _, loadedSkills, runErr := runSlackTask(
					runCtx,
					d,
					logger,
					logOpts,
					client,
					reg,
					sharedGuard,
					cfg,
					model,
					job,
					h,
					sticky,
					taskRuntimeOpts,
				)
				cancel()

				if runErr != nil {
					if workerCtx.Err() != nil {
						return
					}
					callErrorHook(workerCtx, logger, hooks, ErrorEvent{
						Stage:           ErrorStageRunTask,
						ConversationKey: job.ConversationKey,
						TeamID:          job.TeamID,
						ChannelID:       job.ChannelID,
						MessageTS:       job.MessageTS,
						Err:             runErr,
					})
					errorText := "error: " + runErr.Error()
					errorCorrelationID := fmt.Sprintf("slack:error:%s:%s", job.ChannelID, job.MessageTS)
					_, err := publishSlackBusOutbound(
						workerCtx,
						inprocBus,
						job.TeamID,
						job.ChannelID,
						errorText,
						job.ThreadTS,
						errorCorrelationID,
					)
					if err != nil {
						logger.Warn("slack_bus_publish_error", "channel", busruntime.ChannelSlack, "channel_id", job.ChannelID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
						callErrorHook(workerCtx, logger, hooks, ErrorEvent{
							Stage:           ErrorStagePublishErrorReply,
							ConversationKey: job.ConversationKey,
							TeamID:          job.TeamID,
							ChannelID:       job.ChannelID,
							MessageTS:       job.MessageTS,
							Err:             err,
						})
					}
					return
				}

				outText := strings.TrimSpace(formatFinalOutput(final))
				if outText != "" {
					if workerCtx.Err() != nil {
						return
					}
					outCorrelationID := fmt.Sprintf("slack:message:%s:%s", job.ChannelID, job.MessageTS)
					_, err := publishSlackBusOutbound(
						workerCtx,
						inprocBus,
						job.TeamID,
						job.ChannelID,
						outText,
						job.ThreadTS,
						outCorrelationID,
					)
					if err != nil {
						logger.Warn("slack_bus_publish_error", "channel", busruntime.ChannelSlack, "channel_id", job.ChannelID, "bus_error_code", busErrorCodeString(err), "error", err.Error())
						callErrorHook(workerCtx, logger, hooks, ErrorEvent{
							Stage:           ErrorStagePublishOutbound,
							ConversationKey: job.ConversationKey,
							TeamID:          job.TeamID,
							ChannelID:       job.ChannelID,
							MessageTS:       job.MessageTS,
							Err:             err,
						})
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
			},
		})
		return w
	}

	enqueueSlackInbound = func(ctx context.Context, msg busruntime.BusMessage) error {
		if ctx == nil {
			ctx = workersCtx
		}
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
		if err := runtimeworker.Enqueue(ctx, workersCtx, w.Jobs, job); err != nil {
			return err
		}
		callInboundHook(ctx, logger, hooks, InboundEvent{
			ConversationKey: msg.ConversationKey,
			TeamID:          inbound.TeamID,
			ChannelID:       inbound.ChannelID,
			ChatType:        inbound.ChatType,
			MessageTS:       inbound.MessageTS,
			ThreadTS:        inbound.ThreadTS,
			UserID:          inbound.UserID,
			Text:            text,
			MentionUsers:    append([]string(nil), inbound.MentionUsers...),
		})
		return nil
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
			if err != nil {
				callErrorHook(ctx, logger, hooks, ErrorEvent{
					Stage:           ErrorStageDeliverOutbound,
					ConversationKey: msg.ConversationKey,
					Err:             err,
				})
				return err
			}
			event, eventErr := slackOutboundEventFromBusMessage(msg)
			if eventErr != nil {
				callErrorHook(ctx, logger, hooks, ErrorEvent{
					Stage:           ErrorStageDeliverOutbound,
					ConversationKey: msg.ConversationKey,
					Err:             eventErr,
				})
			} else {
				callOutboundHook(ctx, logger, hooks, event)
			}
			return nil
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
		if ctx.Err() != nil {
			logger.Info("slack_stop", "reason", "context_canceled")
			return nil
		}
		conn, err := api.connectSocket(ctx)
		if err != nil {
			if ctx.Err() != nil {
				logger.Info("slack_stop", "reason", "context_canceled")
				return nil
			}
			logger.Warn("slack_socket_connect_error", "error", err.Error())
			callErrorHook(ctx, logger, hooks, ErrorEvent{
				Stage: ErrorStageSocketConnect,
				Err:   err,
			})
			if err := sleepWithContext(ctx, 2*time.Second); err != nil {
				return nil
			}
			continue
		}
		logger.Info("slack_socket_connected")
		readErr := consumeSlackSocket(ctx, conn, func(envelope slackSocketEnvelope) error {
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
			conversationKey, err := buildSlackConversationKey(event.TeamID, event.ChannelID)
			if err != nil {
				return err
			}

			isGroup := isSlackGroupChat(event.ChatType)
			if isGroup {
				mu.Lock()
				historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
				mu.Unlock()
				dec, accepted, err := decideSlackGroupTrigger(
					context.Background(),
					client,
					model,
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
					callErrorHook(context.Background(), logger, hooks, ErrorEvent{
						Stage:           ErrorStageGroupTrigger,
						ConversationKey: conversationKey,
						TeamID:          event.TeamID,
						ChannelID:       event.ChannelID,
						MessageTS:       event.MessageTS,
						Err:             err,
					})
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
				callErrorHook(context.Background(), logger, hooks, ErrorEvent{
					Stage:           ErrorStagePublishInbound,
					ConversationKey: conversationKey,
					TeamID:          event.TeamID,
					ChannelID:       event.ChannelID,
					MessageTS:       event.MessageTS,
					Err:             err,
				})
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
			callErrorHook(ctx, logger, hooks, ErrorEvent{
				Stage: ErrorStageSocketRead,
				Err:   readErr,
			})
		}
	}
}

func slackOutboundEventFromBusMessage(msg busruntime.BusMessage) (OutboundEvent, error) {
	teamID := strings.TrimSpace(msg.Extensions.TeamID)
	channelID := strings.TrimSpace(msg.Extensions.ChannelID)
	if teamID == "" || channelID == "" {
		parsedTeamID, parsedChannelID, err := slackConversationPartsFromKey(msg.ConversationKey)
		if err != nil {
			return OutboundEvent{}, err
		}
		if teamID == "" {
			teamID = parsedTeamID
		}
		if channelID == "" {
			channelID = parsedChannelID
		}
	}
	env, err := msg.Envelope()
	if err != nil {
		return OutboundEvent{}, err
	}
	threadTS := strings.TrimSpace(msg.Extensions.ThreadTS)
	if threadTS == "" {
		threadTS = strings.TrimSpace(msg.Extensions.ReplyTo)
	}
	if threadTS == "" {
		threadTS = strings.TrimSpace(env.ReplyTo)
	}
	return OutboundEvent{
		ConversationKey: strings.TrimSpace(msg.ConversationKey),
		TeamID:          teamID,
		ChannelID:       channelID,
		ThreadTS:        threadTS,
		Text:            strings.TrimSpace(env.Text),
		CorrelationID:   strings.TrimSpace(msg.CorrelationID),
		Kind:            slackOutboundKind(msg.CorrelationID),
	}, nil
}

func slackConversationPartsFromKey(conversationKey string) (string, string, error) {
	const prefix = "slack:"
	if !strings.HasPrefix(conversationKey, prefix) {
		return "", "", fmt.Errorf("slack conversation key is invalid")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(conversationKey, prefix))
	parts := strings.Split(raw, ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("slack conversation key is invalid")
	}
	teamID := strings.TrimSpace(parts[0])
	channelID := strings.TrimSpace(parts[1])
	if teamID == "" || channelID == "" {
		return "", "", fmt.Errorf("slack conversation key is invalid")
	}
	return teamID, channelID, nil
}

func slackOutboundKind(correlationID string) string {
	id := strings.ToLower(strings.TrimSpace(correlationID))
	if strings.Contains(id, ":error:") {
		return "error"
	}
	return "message"
}

func normalizeThreshold(primary, secondary, def float64) float64 {
	v := primary
	if v <= 0 {
		v = secondary
	}
	if v <= 0 {
		v = def
	}
	if v > 1 {
		return 1
	}
	return v
}
