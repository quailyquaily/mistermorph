package agent

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/platformutil"
	"github.com/quailyquaily/mistermorph/internal/runtimeclock"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type Hook func(ctx context.Context, step int, agentCtx *Context, messages *[]llm.Message) error

type Option func(*Engine)

func WithHook(h Hook) Option {
	return func(e *Engine) {
		if h != nil {
			e.hooks = append(e.hooks, h)
		}
	}
}

func WithLogger(l *slog.Logger) Option {
	return func(e *Engine) {
		if l != nil {
			e.log = l
		}
	}
}

func WithSystemPromptCacheControl(ctrl *llm.CacheControl) Option {
	return func(e *Engine) {
		if ctrl == nil {
			return
		}
		cloned := *ctrl
		e.systemPromptCacheControl = &cloned
	}
}

// WithPromptBuilder replaces the default system prompt builder.
// This hook is intended for tests in this repository.
func WithPromptBuilder(fn func(*tools.Registry, string) string) Option {
	return func(e *Engine) {
		if fn != nil {
			e.promptBuilder = fn
		}
	}
}

func WithParamsBuilder(fn func(RunOptions) map[string]any) Option {
	return func(e *Engine) {
		if fn != nil {
			e.paramsBuilder = fn
		}
	}
}

func WithOnToolStart(fn func(*Context, string)) Option {
	return func(e *Engine) {
		if fn != nil {
			e.onToolStart = fn
		}
	}
}

func WithOnToolSuccess(fn func(*Context, string)) Option {
	return func(e *Engine) {
		if fn != nil {
			e.onToolSuccess = fn
		}
	}
}

func WithOnToolCallStart(fn func(*Context, ToolCall)) Option {
	return func(e *Engine) {
		if fn != nil {
			e.onToolCallStart = fn
		}
	}
}

func WithOnToolCallDone(fn func(*Context, ToolCall, string, error)) Option {
	return func(e *Engine) {
		if fn != nil {
			e.onToolCallDone = fn
		}
	}
}

func WithPlanStepUpdate(fn func(*Context, PlanStepUpdate)) Option {
	return func(e *Engine) {
		if fn != nil {
			e.onPlanStepUpdate = fn
		}
	}
}

func WithFallbackFinal(fn func() *Final) Option {
	return func(e *Engine) {
		if fn != nil {
			e.fallbackFinal = fn
		}
	}
}

// SubtaskProfile is what a subtask runs on when spawn selects a model profile.
type SubtaskProfile struct {
	Client                   llm.Client
	Model                    string
	SystemPromptCacheControl *llm.CacheControl
	// Close, when set, is called after the subtask ends.
	Close func()
}

// SubtaskProfileResolver resolves a model profile by name for a subtask the engine runs itself.
// It returns an error for a profile that does not exist or cannot run a subtask.
type SubtaskProfileResolver func(ctx context.Context, profile string) (SubtaskProfile, error)

// WithSubtaskProfileResolver lets spawn's model_profile work when the engine runs subtasks itself.
// Without it, a subtask that selects a profile fails. It is not used with WithSubtaskRunner.
func WithSubtaskProfileResolver(fn SubtaskProfileResolver) Option {
	return func(e *Engine) {
		if fn != nil {
			e.subtaskProfileResolver = fn
		}
	}
}

// WithModelProfiles registers list_model_profiles next to spawn, listing the profiles a subtask
// can select. Leave it out when there is nothing to choose between.
func WithModelProfiles(fn ModelProfileLister) Option {
	return func(e *Engine) {
		if fn != nil {
			e.modelProfiles = fn
		}
	}
}

func WithSubtaskRunner(runner SubtaskRunner) Option {
	return func(e *Engine) {
		if runner != nil {
			e.subtaskRunner = runner
		}
	}
}

func WithEngineToolsConfig(cfg EngineToolsConfig) Option {
	return func(e *Engine) {
		e.engineToolsConfig = cfg
	}
}

type Config struct {
	MaxSteps          int
	MaxTokenBudget    int
	ParseRetries      int
	ToolRepeatLimit   int
	DefaultModel      string
	ToolCallTimeout   time.Duration
	ContextCompaction ContextCompactionConfig
}

type Engine struct {
	client   llm.Client
	registry *tools.Registry
	config   Config
	spec     PromptSpec
	hooks    []Hook
	log      *slog.Logger
	logOpts  LogOptions

	engineToolsConfig EngineToolsConfig

	systemPromptCacheControl *llm.CacheControl

	promptBuilder    func(registry *tools.Registry, task string) string
	paramsBuilder    func(opts RunOptions) map[string]any
	onToolStart      func(ctx *Context, toolName string)
	onToolSuccess    func(ctx *Context, toolName string)
	onToolCallStart  func(ctx *Context, tc ToolCall)
	onToolCallDone   func(ctx *Context, tc ToolCall, observation string, err error)
	onPlanStepUpdate func(ctx *Context, update PlanStepUpdate)
	fallbackFinal    func() *Final

	subtaskRunner          SubtaskRunner
	subtaskProfileResolver SubtaskProfileResolver
	modelProfiles          ModelProfileLister

	guard *guard.Guard

	// toolSearch, when set, hides the tools it marks until the model finds them with tool_search.
	toolSearch *ToolSearchOptions
	codeMode   *CodeModeOptions
}

func New(client llm.Client, registry *tools.Registry, cfg Config, spec PromptSpec, opts ...Option) *Engine {
	if cfg.MaxSteps <= 0 {
		cfg.MaxSteps = DefaultMaxSteps
	}
	if cfg.ParseRetries < 0 {
		cfg.ParseRetries = 0
	}
	if cfg.ToolRepeatLimit <= 0 {
		cfg.ToolRepeatLimit = DefaultToolRepeatLimit
	}
	if spec.Identity == "" {
		spec = DefaultPromptSpec()
	}
	e := &Engine{
		client:            client,
		registry:          registry.Clone(),
		config:            cfg,
		spec:              spec,
		log:               slog.Default(),
		logOpts:           DefaultLogOptions(),
		engineToolsConfig: DefaultEngineToolsConfig(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(e)
		}
	}
	if e.subtaskRunner == nil {
		e.subtaskRunner = &localSubtaskRunner{engine: e}
	}
	if e.toolSearch != nil {
		if err := e.registry.Register(&toolSearchTool{engine: e}); err != nil {
			// The runtime refuses a registry with its own tool_search before getting here.
			e.log.Warn("tool_search_disabled", "error", err.Error())
			e.toolSearch = nil
		} else {
			e.spec.Blocks = append(e.spec.Blocks, PromptBlock{Content: toolSearchPrompt(e.toolSearch.Catalog)})
		}
	}
	if e.codeMode != nil {
		if err := e.registry.Register(&codeModeTool{engine: e}); err != nil {
			// The runtime refuses a registry with its own codemode before getting here.
			e.log.Warn("codemode_disabled", "error", err.Error())
			e.codeMode = nil
		} else {
			e.spec.Blocks = append(e.spec.Blocks, PromptBlock{Content: codeModePromptBlock})
		}
	}
	blocks := registerEngineTools(
		e.registry,
		e.engineToolsConfig,
		spawnToolDeps{
			LookupTool: e.lookupSubtaskTool,
			Runner:     e.subtaskRunner,
		},
		coderToolDeps{
			Runner: e.subtaskRunner,
			RunCLI: runCoderCLI,
		},
		e.modelProfiles,
	)
	e.spec.Blocks = append(e.spec.Blocks, blocks...)
	return e
}

func (e *Engine) Run(ctx context.Context, task string, opts RunOptions) (*Final, *Context, error) {
	agentCtx := NewContext(task, e.config.MaxSteps)
	if err := e.config.ContextCompaction.Validate(); err != nil {
		return nil, agentCtx, err
	}

	model := strings.TrimSpace(opts.Model)
	if model == "" {
		model = strings.TrimSpace(e.config.DefaultModel)
	}
	contextWindowTokens := opts.ContextWindowTokens
	if contextWindowTokens <= 0 {
		if entry, ok := llm.ResolveModelContextWindow(model); ok {
			contextWindowTokens = entry.ContextWindowTokens
		}
	}

	runID := llmstats.RunIDFromContext(ctx)
	if runID == "" {
		runID = newRunID()
	}
	ctx = llmstats.WithRunID(ctx, runID)
	log := e.log.With("run_id", runID, "model", model)
	toolLog := e.log.With("run_id", runID)
	log.Info("run_start", "task_len", len(task))
	if opts.SteerSource != nil {
		defer opts.SteerSource.Close()
	}

	var visibleNames []string
	if e.toolSearch != nil {
		visibleNames = e.toolSearch.Visible
	}
	search := e.startToolSearch(ctx, visibleNames, nil)
	promptRegistry := e.visibleRegistry(search)
	var systemPrompt string
	if e.promptBuilder != nil {
		systemPrompt = e.promptBuilder(promptRegistry, task)
	} else {
		systemPrompt = BuildSystemPrompt(promptRegistry, e.spec)
	}

	systemMessage := llm.Message{Role: "system", Content: systemPrompt}
	if e.systemPromptCacheControl != nil && strings.TrimSpace(systemPrompt) != "" {
		ctrl := *e.systemPromptCacheControl
		systemMessage.Parts = []llm.Part{{
			Type:         llm.PartTypeText,
			Text:         systemPrompt,
			CacheControl: &ctrl,
		}}
	}

	messages := []llm.Message{systemMessage}

	fixedMessageCount := len(messages)
	checkpointStore := opts.ContextCheckpointStore
	if checkpointStore == nil {
		checkpointStore = newRunLocalCheckpointStore()
	}
	loadedCheckpoint, hasCheckpoint, err := checkpointStore.Load(ctx)
	if err != nil {
		return nil, agentCtx, fmt.Errorf("load context checkpoint: %w", err)
	}
	messageBoundaries := make(map[int]string)
	if hasCheckpoint {
		messages, err = insertLoadedCheckpoint(messages, fixedMessageCount, loadedCheckpoint)
		if err != nil {
			return nil, agentCtx, fmt.Errorf("load context checkpoint: %w", err)
		}
		if boundary := strings.TrimSpace(loadedCheckpoint.CoveredThrough); boundary != "" {
			messageBoundaries[fixedMessageCount] = boundary
		}
	}

	for historyIndex, m := range opts.History {
		if strings.TrimSpace(strings.ToLower(m.Role)) == "system" {
			continue
		}
		if strings.TrimSpace(m.Content) == "" && len(m.Parts) == 0 {
			continue
		}
		messageIndex := len(messages)
		messages = append(messages, m)
		if historyIndex < len(opts.HistoryBoundaries) {
			if boundary := strings.TrimSpace(opts.HistoryBoundaries[historyIndex]); boundary != "" {
				messageBoundaries[messageIndex] = boundary
			}
		}
	}

	var metaMessageIndex *int
	injectedMeta := runtimeclock.WithRuntimeClockMeta(opts.Meta, time.Now())
	if modelName := llm.ShortModelName(model); modelName != "" {
		injectedMeta["model"] = modelName
	}
	injectedMeta["run_id"] = runID
	if _, ok := injectedMeta["host_os"]; !ok {
		injectedMeta["host_os"] = platformutil.Current()
	}
	if metaMsg, ok := buildInjectedMetaMessage(injectedMeta); ok {
		trigger := ""
		if v, ok := injectedMeta["trigger"].(string); ok {
			trigger = strings.TrimSpace(v)
		}
		index := len(messages)
		metaMessageIndex = &index
		messages = append(messages, llm.Message{Role: "user", Content: metaMsg})
		log.Debug(
			"run_meta_injected",
			"meta_bytes", len(metaMsg),
			"meta_keys", sortedMapKeys(injectedMeta),
			"meta_trigger", trigger,
			"meta_payload", metaMsg,
		)
	}

	if opts.CurrentMessage != nil {
		current := *opts.CurrentMessage
		current.Role = "user"
		if strings.TrimSpace(current.Content) != "" || len(current.Parts) > 0 {
			messageIndex := len(messages)
			messages = append(messages, current)
			if boundary := strings.TrimSpace(opts.CurrentMessageBoundary); boundary != "" {
				messageBoundaries[messageIndex] = boundary
			}
		}
	} else if !opts.SkipTaskMessage {
		if strings.TrimSpace(task) != "" {
			messageIndex := len(messages)
			messages = append(messages, llm.Message{Role: "user", Content: task})
			if boundary := strings.TrimSpace(opts.CurrentMessageBoundary); boundary != "" {
				messageBoundaries[messageIndex] = boundary
			}
		}
	}

	requestedWrites := ExtractFileWritePaths(task)

	var extraParams map[string]any
	if e.paramsBuilder != nil {
		extraParams = e.paramsBuilder(opts)
	}

	loopState := &engineLoopState{
		sessionID:             strings.TrimSpace(opts.SessionID),
		runID:                 runID,
		model:                 model,
		scene:                 strings.TrimSpace(opts.Scene),
		log:                   log,
		toolLog:               toolLog,
		messages:              messages,
		agentCtx:              agentCtx,
		extraParams:           extraParams,
		tools:                 e.llmToolsForRun(search),
		search:                search,
		planRequired:          false,
		requestedWrites:       requestedWrites,
		reasoningDetails:      opts.ReasoningDetails,
		onStream:              opts.OnStream,
		steerSource:           opts.SteerSource,
		nextStep:              0,
		fixedMessageCount:     fixedMessageCount,
		metaMessageIndex:      metaMessageIndex,
		messageBoundaries:     messageBoundaries,
		checkpointStore:       checkpointStore,
		checkpoint:            loadedCheckpoint,
		hasCheckpoint:         hasCheckpoint,
		contextCompaction:     resolveContextCompactionConfig(e.config.ContextCompaction, opts.DisableContextCompaction),
		contextCompactionOnly: opts.ContextCompactionOnly,
		contextWindowTokens:   contextWindowTokens,
	}
	if opts.ContextCompactionOnly {
		loopState.protectLastMessage()
	}
	return e.runLoop(ctx, loopState)
}

func missingFiles(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			continue
		}
		out = append(out, p)
	}
	return out
}

func sortedMapKeys(m map[string]any) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// lookupSubtaskTool finds a tool a subtask may be given. Tools hidden by tool search and
// codemode are never handed to subtasks.
func (e *Engine) lookupSubtaskTool(name string) (tools.Tool, bool) {
	tool, ok := e.registry.Get(name)
	if name == codeModeToolName {
		return nil, false
	}
	if !ok || e.toolSearch == nil {
		return tool, ok
	}
	if e.toolSearch.Hidden(tool) || name == toolSearchToolName {
		return nil, false
	}
	return tool, true
}
