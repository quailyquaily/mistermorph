// Package socialpost answers public mentions on a social network (Bluesky, X): a post that mentions
// the account, or replies to it, starts a task, and the task's final answer is posted as a reply
// in the thread. Nothing else is ever posted: no commands, approvals, plan progress or errors,
// since everything in a thread is public. See docs/feat/feat_20261011_x_bluesky_channels.md.
package socialpost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/imageinput"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/outputfmt"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/textutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

const (
	llmMaxImages     = 3
	llmImageMaxBytes = int64(5 << 20)
	// approvalNotice answers a request that would need an approval, which a public thread cannot hold.
	approvalNotice = "Sorry, I can't do that in a public reply."
)

// Post is a public post the source delivers or reads from a thread.
type Post struct {
	ID string
	// ThreadID is the thread's root post; it keys the conversation.
	ThreadID     string
	AuthorID     string
	AuthorHandle string
	AuthorName   string
	// AuthorIsBot: the author labels itself automated. Its mentions are not answered, so two agents
	// never answer each other in public.
	AuthorIsBot bool
	Text        string
	CreatedAt   time.Time
	Images      []Image
	// Ref is what the source needs to reply to the post.
	Ref any
}

// Image is an image a post carries, downloaded when the task starts.
type Image struct {
	MIMEType string
	Fetch    func(ctx context.Context) ([]byte, string, error)
}

// Source is a platform's public posts.
type Source interface {
	// Run polls the account's mentions and replies until ctx ends, passing each new one to deliver,
	// oldest first.
	Run(ctx context.Context, deliver func(context.Context, Post) error) error
	// Thread returns up to depth posts above post, oldest first, without post itself.
	Thread(ctx context.Context, post Post, depth int) ([]Post, error)
	// Reply posts parts as a thread of replies under post, in order.
	Reply(ctx context.Context, post Post, parts []string) error
	// Split cuts text into at most maxPosts posts; text that does not fit is shortened.
	Split(text string, maxPosts int) []string
	// SelfID is the account's own user ID, "" until it is known.
	SelfID() string
}

// Options configure the runtime.
type Options struct {
	// Channel names the runtime ("bluesky", "x") in tasks, logs and state files.
	Channel string
	Source  Source
	// AllowedUserIDs, when set, are the only users whose mentions are answered.
	AllowedUserIDs []string
	BlockedUserIDs []string
	// ThreadContextDepth is how many posts above a mention the task reads.
	ThreadContextDepth int
	// MaxReplyPosts is the most posts one answer is split into.
	MaxReplyPosts int
	// MaxPostsPerDay caps the posts made in a UTC day; 0 is no cap.
	MaxPostsPerDay int
	// PromptBlocks adds the platform's policies to each task's prompt.
	PromptBlocks func(spec *agent.PromptSpec)

	TaskTimeout       time.Duration
	MaxConcurrency    int
	AgentLimits       agent.Limits
	EngineToolsConfig agent.EngineToolsConfig
	InspectPrompt     bool
	InspectRequest    bool
	FileCacheDir      string
	// TaskStore records the tasks; nil gives the runtime a store of its own.
	TaskStore      daemonruntime.TaskView
	ServerMaxQueue int

	now func() time.Time
}

func normalizeOptions(opts Options) Options {
	if opts.TaskTimeout <= 0 {
		opts.TaskTimeout = configdefaults.DefaultTaskTimeout
	}
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = configdefaults.DefaultChannelMaxConcurrency
	}
	if opts.MaxReplyPosts <= 0 {
		opts.MaxReplyPosts = 3
	}
	if opts.ThreadContextDepth < 0 {
		opts.ThreadContextDepth = 0
	}
	if opts.ServerMaxQueue <= 0 {
		opts.ServerMaxQueue = configdefaults.DefaultServerMaxQueue
	}
	if opts.now == nil {
		opts.now = time.Now
	}
	opts.AgentLimits = opts.AgentLimits.NormalizeForRuntime()
	return opts
}

type job struct {
	TaskID          string
	ConversationKey string
	Post            Post
	WorkspaceDir    string
	Generation      *runtimecore.RuntimeGenerationLease
}

func (j job) release() {
	if j.Generation != nil {
		j.Generation.Release()
	}
}

// Run answers mentions until ctx ends.
func Run(ctx context.Context, d depsutil.CommonDependencies, opts Options) error {
	opts = normalizeOptions(opts)
	if opts.Source == nil || strings.TrimSpace(opts.Channel) == "" {
		return fmt.Errorf("social post source and channel are required")
	}
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	mode := opts.Channel + "_post"
	logger = logger.With("channel", opts.Channel, "mode", "mentions")
	taskStore := opts.TaskStore
	if taskStore == nil {
		taskStore, err = daemonruntime.NewTaskViewForTarget(opts.Channel, opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: d.TaskPersistenceTargets, TasksDir: d.RuntimePaths.TasksDir,
			JournalDir: d.RuntimePaths.JournalDir, RotateMaxBytes: d.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
	}
	generations, err := runtimecore.BootstrapRuntimeGenerationManager(ctx, d, runtimecore.ChannelBootstrapOptions{
		Mode: mode, InspectRequest: opts.InspectRequest, InspectPrompt: opts.InspectPrompt,
		AgentConfig: opts.AgentLimits.ToConfig(), EngineToolsConfig: &opts.EngineToolsConfig, Logger: logger,
	})
	if err != nil {
		return err
	}
	defer generations.Close()
	generations.Start(ctx)

	state := newState(d.RuntimePaths.StateDir, opts.Channel, opts.now)
	gate := newGate(opts)
	workspaceStore := workspace.NewStore(d.RuntimePaths.WorkspaceAttachmentsPath)
	runControl := runtimecontrol.New()
	var limiter runtimecore.AgentInteractionLimiter

	workersCtx, stopWorkers := context.WithCancel(context.WithoutCancel(ctx))
	sem := make(chan struct{}, opts.MaxConcurrency)
	runner := runtimecore.NewConversationRunner(workersCtx, sem, 16, func(workerCtx context.Context, conversationKey string, j job) {
		defer j.release()
		bundle := j.Generation.Bundle()
		if bundle == nil || bundle.TaskRuntime == nil {
			markTaskFailed(logger, taskStore, j.TaskID, opts.Channel+" runtime generation is unavailable")
			return
		}
		if err := runtimecore.MarkTaskRunning(taskStore, j.TaskID); err != nil {
			logger.Error("task_state_write_error", "task_id", j.TaskID, "error", err.Error())
			return
		}
		lease, err := runControl.StartLease(workerCtx, opts.TaskTimeout, runtimecontrol.ActiveRun{
			Runtime: mode, ConversationKey: conversationKey, TopicID: j.Post.ThreadID, TaskID: j.TaskID, RunID: j.TaskID,
		})
		if err != nil {
			markTaskFailed(logger, taskStore, j.TaskID, err.Error())
			return
		}
		thread, threadErr := opts.Source.Thread(lease.Context, j.Post, opts.ThreadContextDepth)
		if threadErr != nil {
			logger.Warn("thread_read_failed", "post_id", j.Post.ID, "error", threadErr.Error())
		}
		result, runErr := runTask(lease.Context, bundle.TaskRuntime, logger, opts, j, thread, lease.SteerQueue)
		lease.Finish()
		if runErr != nil {
			// Errors stay private: a public thread is no place for them.
			markTaskFailed(logger, taskStore, j.TaskID, depsutil.FormatRuntimeError(runErr))
			logger.Warn("task_error", "post_id", j.Post.ID, "error", runErr.Error())
			return
		}
		output := strings.TrimSpace(outputfmt.FormatFinalOutput(result.Final))
		if _, pending := runtimecore.PendingApprovalID(result.Final); pending {
			output = approvalNotice
		}
		if output == "" {
			if err := runtimecore.MarkTaskDone(taskStore, j.TaskID, ""); err != nil {
				logger.Error("task_state_write_error", "task_id", j.TaskID, "error", err.Error())
			}
			return
		}
		parts := opts.Source.Split(output, opts.MaxReplyPosts)
		if !state.takePosts(len(parts), opts.MaxPostsPerDay) {
			markTaskFailed(logger, taskStore, j.TaskID, fmt.Sprintf("the daily limit of %d posts is reached; the answer was not posted", opts.MaxPostsPerDay))
			logger.Warn("daily_post_limit", "post_id", j.Post.ID, "limit", opts.MaxPostsPerDay)
			return
		}
		if err := opts.Source.Reply(workerCtx, j.Post, parts); err != nil {
			markTaskFailed(logger, taskStore, j.TaskID, "post reply: "+err.Error())
			logger.Warn("reply_failed", "post_id", j.Post.ID, "error", err.Error())
			return
		}
		logger.Info("replied", "post_id", j.Post.ID, "posts", len(parts))
		if err := runtimecore.MarkTaskDone(taskStore, j.TaskID, strings.Join(parts, "\n\n")); err != nil {
			logger.Error("task_state_write_error", "task_id", j.TaskID, "error", err.Error())
		}
	}, runtimecore.ConversationRunnerOptions[string, job]{
		Logger: logger,
		OnDrop: func(_ string, j job) {
			markTaskFailed(logger, taskStore, j.TaskID, opts.Channel+" runtime closed")
			j.release()
		},
		OnPanic: func(conversationKey string, j job) {
			defer j.release()
			runControl.Finish(mode, conversationKey, j.TaskID)
			markTaskFailed(logger, taskStore, j.TaskID, "conversation worker panicked")
		},
	})
	defer func() {
		stopWorkers()
		runner.WaitClosed()
	}()

	deliver := func(handlerCtx context.Context, post Post) error {
		if state.seen(post.ID) {
			return nil
		}
		decision := gate.admit(post, opts.Source.SelfID(), state)
		state.markSeen(post.ID)
		if decision != "" {
			logger.Info("mention_skipped", "post_id", post.ID, "author_id", post.AuthorID, "reason", decision)
			return nil
		}
		conversationKey := ConversationKey(opts.Channel, post.ThreadID)
		if !limiter.Allow(conversationKey+":"+post.AuthorID, opts.now()) {
			logger.Info("mention_rate_limited", "post_id", post.ID, "author_id", post.AuthorID)
			return nil
		}
		taskID := daemonruntime.BuildTaskID(opts.Channel+"p", post.AuthorID, post.ID)
		generation, err := generations.Capture()
		if err != nil {
			return err
		}
		resolution, err := workspace.Resolve(workspaceStore, conversationKey, d.DefaultWorkspaceDir)
		if err != nil {
			generation.Release()
			return err
		}
		createdAt := post.CreatedAt.UTC()
		if createdAt.IsZero() {
			createdAt = opts.now().UTC()
		}
		if err := taskdomain.RecordTaskUpsert(taskStore, daemonruntime.TaskInfo{
			ID: taskID, Status: daemonruntime.TaskQueued, Task: textutil.TruncateRunes(post.Text, 2000),
			Timeout: opts.TaskTimeout.String(), CreatedAt: createdAt,
			Conversation: runtimecore.BuildTaskConversation(conversationKey, "public", post.AuthorID, authorDisplay(post), "", nil),
			Result:       map[string]any{"source": mode, opts.Channel + "_post_id": post.ID, opts.Channel + "_thread_id": post.ThreadID},
		}, daemonruntime.TaskTrigger{Source: mode, Event: "mention", Ref: post.ID}); err != nil {
			generation.Release()
			return err
		}
		build := func(uint64) job {
			return job{TaskID: taskID, ConversationKey: conversationKey, Post: post, WorkspaceDir: resolution.WorkspaceDir, Generation: generation}
		}
		if err := runner.Enqueue(handlerCtx, conversationKey, build); err != nil {
			generation.Release()
			markTaskFailed(logger, taskStore, taskID, err.Error())
			return err
		}
		logger.Info("task_enqueued", "post_id", post.ID, "author_id", post.AuthorID, "conversation_key", conversationKey)
		return nil
	}
	logger.Info("runtime_start", "max_reply_posts", opts.MaxReplyPosts, "max_posts_per_day", opts.MaxPostsPerDay)
	err = opts.Source.Run(ctx, deliver)
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return nil
	}
	return err
}

// ConversationKey keys a public thread: "<channel>_thread:<root post>".
func ConversationKey(channel, threadID string) string {
	return channel + "_thread:" + strings.TrimSpace(threadID)
}

func runTask(ctx context.Context, rt *taskruntime.Runtime, logger *slog.Logger, opts Options, j job, thread []Post, steer agent.SteerSource) (taskruntime.RunResult, error) {
	ctx = llmstats.WithMetadata(ctx, j.TaskID, j.Post.ID)
	ctx = topiccontext.WithScope(ctx, topiccontext.Scope{Runtime: opts.Channel + "_post", ConversationKey: j.ConversationKey, TopicID: j.Post.ThreadID})
	ctx = pathroots.WithWorkspaceDir(ctx, j.WorkspaceDir)
	// A public reply is the only answer; the task must not message the author elsewhere.
	ctx = builtin.WithContactsSendRuntimeContext(ctx, builtin.ContactsSendRuntimeContext{ForbiddenTargetIDs: []string{opts.Channel + "_user:" + j.Post.AuthorID}})
	route, err := rt.ResolveTaskRouteForRun(llmstats.WithRunID(ctx, j.TaskID), j.Post.Text)
	if err != nil {
		return taskruntime.RunResult{}, err
	}
	self := opts.Source.SelfID()
	history := make([]chathistory.ChatHistoryItem, 0, len(thread))
	for _, post := range thread {
		history = append(history, historyItem(opts.Channel, post, self))
	}
	current := historyItem(opts.Channel, j.Post, self)
	checkpoint, err := rt.PrepareContextHistory(ctx, j.ConversationKey, history, current)
	if err != nil {
		return taskruntime.RunResult{}, err
	}
	imagePaths := saveImages(ctx, opts, j.Post, logger)
	raw := imageinput.AppendImagePathNotes(chathistory.RenderCurrentMessage(current), imagePaths, opts.FileCacheDir)
	message, err := imageinput.BuildUserMessage(raw, strings.TrimSpace(route.ClientConfig.Model), imagePaths, imageinput.MessageOptions{
		MaxImages: llmMaxImages, MaxBytes: llmImageMaxBytes,
		SupportsImageParts: route.Values.SupportsImageParts, Logger: logger, LogPrefix: opts.Channel,
	})
	if err != nil {
		message = llm.Message{Role: "user", Content: raw}
	}
	meta := taskruntime.ApplyObservationMeta(map[string]any{
		"trigger":                     opts.Channel + "_post",
		opts.Channel + "_post_id":     j.Post.ID,
		opts.Channel + "_thread_id":   j.Post.ThreadID,
		opts.Channel + "_author_id":   j.Post.AuthorID,
		opts.Channel + "_author_name": authorDisplay(j.Post),
	}, taskruntime.ObservationMetaIDs{TaskID: j.TaskID, TraceID: j.TaskID, TopicID: j.Post.ThreadID, OriginEventID: j.Post.ID})
	return rt.Run(ctx, taskruntime.RunRequest{
		Task:           j.Post.Text,
		Model:          strings.TrimSpace(route.ClientConfig.Model),
		Route:          &route,
		Scene:          opts.Channel + ".post",
		History:        chathistory.RenderHistoryMessages(checkpoint.History),
		CurrentMessage: &message,
		Meta:           meta,
		Registry:       rt.BaseRegistry.Clone(),
		PromptAugment: func(spec *agent.PromptSpec, _ *tools.Registry) {
			if block := workspace.PromptBlock(j.WorkspaceDir); strings.TrimSpace(block.Content) != "" {
				spec.Blocks = append([]agent.PromptBlock{block}, spec.Blocks...)
			}
			if opts.PromptBlocks != nil {
				opts.PromptBlocks(spec)
			}
		},
		SteerSource:            steer,
		ImageToolScope:         j.ConversationKey,
		ContextCheckpointStore: checkpoint.Store,
		HistoryBoundaries:      checkpoint.HistoryBoundaries,
		CurrentMessageBoundary: checkpoint.CurrentMessageBoundary,
	})
}

func historyItem(channel string, post Post, self string) chathistory.ChatHistoryItem {
	display := authorDisplay(post)
	kind := chathistory.KindInboundUser
	sender := chathistory.ChatHistorySender{UserID: post.AuthorID, Username: post.AuthorHandle, Nickname: display, IsBot: post.AuthorIsBot, DisplayRef: display}
	if self != "" && post.AuthorID == self {
		kind = chathistory.KindOutboundAgent
		sender = chathistory.ChatHistorySender{Username: "agent", Nickname: "agent", IsBot: true, DisplayRef: "agent"}
	}
	sentAt := post.CreatedAt
	if sentAt.IsZero() {
		sentAt = time.Now()
	}
	return chathistory.ChatHistoryItem{
		Channel:   channel,
		Kind:      kind,
		ChatID:    ConversationKey(channel, post.ThreadID),
		ChatType:  "public",
		MessageID: post.ID,
		SentAt:    sentAt.UTC(),
		Sender:    sender,
		Text:      strings.TrimSpace(post.Text),
	}
}

func authorDisplay(post Post) string {
	name := strings.TrimSpace(post.AuthorName)
	handle := strings.TrimSpace(post.AuthorHandle)
	switch {
	case name != "" && handle != "":
		return name + " (@" + handle + ")"
	case handle != "":
		return "@" + handle
	case name != "":
		return name
	}
	return post.AuthorID
}

func markTaskFailed(logger *slog.Logger, store daemonruntime.TaskUpdater, taskID, message string) {
	if err := runtimecore.MarkTaskFailed(store, taskID, strings.TrimSpace(message), false); err != nil {
		logger.Error("task_state_write_error", "task_id", taskID, "error", err.Error())
	}
}

// gate decides which mentions start a task.
type gate struct {
	allowed map[string]bool
	blocked map[string]bool
}

func newGate(opts Options) *gate {
	g := &gate{allowed: map[string]bool{}, blocked: map[string]bool{}}
	for _, id := range opts.AllowedUserIDs {
		if id = strings.TrimSpace(id); id != "" {
			g.allowed[id] = true
		}
	}
	for _, id := range opts.BlockedUserIDs {
		if id = strings.TrimSpace(id); id != "" {
			g.blocked[id] = true
		}
	}
	return g
}

// admit returns why a mention is not answered, or "" to answer it. "stop" and "start" change the
// author's opt-out and are never answered.
func (g *gate) admit(post Post, self string, state *state) string {
	switch {
	case strings.TrimSpace(post.ID) == "" || strings.TrimSpace(post.AuthorID) == "":
		return "incomplete"
	case self != "" && post.AuthorID == self:
		return "self"
	case post.AuthorIsBot:
		return "bot"
	case g.blocked[post.AuthorID]:
		return "blocked"
	case len(g.allowed) > 0 && !g.allowed[post.AuthorID]:
		return "not_allowed"
	}
	switch optOutCommand(post.Text) {
	case "stop":
		state.setOptOut(post.AuthorID, true)
		return "opt_out"
	case "start":
		state.setOptOut(post.AuthorID, false)
		return "opt_in"
	}
	if state.optedOut(post.AuthorID) {
		return "opted_out"
	}
	if strings.TrimSpace(stripMentions(post.Text)) == "" && len(post.Images) == 0 {
		return "empty"
	}
	return ""
}

// optOutCommand returns "stop" or "start" when that is all the post says besides mentions.
func optOutCommand(text string) string {
	word := strings.ToLower(strings.Trim(strings.TrimSpace(stripMentions(text)), ".!。！"))
	switch word {
	case "stop", "unsubscribe", "停止", "やめて":
		return "stop"
	case "start", "subscribe":
		return "start"
	}
	return ""
}

func stripMentions(text string) string {
	fields := strings.Fields(text)
	kept := fields[:0]
	for _, field := range fields {
		if strings.HasPrefix(field, "@") {
			continue
		}
		kept = append(kept, field)
	}
	return strings.Join(kept, " ")
}
