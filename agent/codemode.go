package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/codemode"
	"github.com/quailyquaily/mistermorph/tools"
)

const codeModeToolName = "codemode"

// Code Mode defaults.
const (
	DefaultCodeModeTimeout      = 120 * time.Second
	DefaultCodeModeMaxToolCalls = 256
	DefaultCodeModeMaxParallel  = 4
)

// CodeModeOptions turn on codemode: a tool that runs a JavaScript program calling the run's tools.
// Zero values use the defaults.
type CodeModeOptions struct {
	Timeout          time.Duration
	MaxToolCalls     int
	MaxParallelCalls int
}

// WithCodeMode enables codemode for the engine's runs. Subtasks never get it.
func WithCodeMode(opts CodeModeOptions) Option {
	return func(e *Engine) {
		if opts.Timeout <= 0 {
			opts.Timeout = DefaultCodeModeTimeout
		}
		if opts.MaxToolCalls <= 0 {
			opts.MaxToolCalls = DefaultCodeModeMaxToolCalls
		}
		if opts.MaxParallelCalls <= 0 {
			opts.MaxParallelCalls = DefaultCodeModeMaxParallel
		}
		e.codeMode = &opts
	}
}

// codeModeMemory watches the process heap for every codemode invocation in the process.
var codeModeMemory = codemode.NewMemoryWatcher()

const codeModePromptBlock = `[[ Code Mode ]]
- ` + "`codemode`" + ` runs JavaScript (the body of an async function) that calls your tools and returns only what the script outputs.
- Prefer ` + "`codemode`" + ` over direct tool calls when you would make two or more calls and combine their results, when one call depends on another's result, or when you need only part of a result that may be large, even from a single call (a file's headings, matching lines of a log, a count, a few fields of a listing): read it in the script, extract what you need there, and return just that. Use a direct call only when you need a result in full.
- Call a tool with ` + "`await tools[\"name\"](args)`" + `; it returns the tool's text result (use JSON.parse when the tool documents JSON) and throws a ToolError on failure. Promise.all runs read-only calls in parallel.
- ` + "`searchTools(query, {server, limit})`" + ` finds tools, and ` + "`describeTool(name)`" + ` returns {name, description, inputSchema}. Tools a search finds can be called in the same script.
- Only ` + "`text(value)`" + `, ` + "`console.log(...)`" + ` and the returned value come back to you; intermediate results do not. Do the work in the script (parse, count, search, filter) and return only the values you need, not whole tool results.
- Scripts cannot call ` + "`bash`" + `, ` + "`powershell`" + `, ` + "`plan_create`" + `, ` + "`message_react`" + `, ` + "`tool_search`" + ` or tools that need approval: call those directly. There are no timers, no imports, no filesystem or network APIs other than your tools.
- A script's output is material for you, not the reply: write your final answer to the user as text, for example a Markdown list, not the script's JSON.
- If the result's status is ` + "`requires_direct_call`" + `, make the pending call directly; do not rerun the script to repeat calls that already succeeded.`

// codeModeTool is codemode. It reads the run's state from the context, like tool_search.
type codeModeTool struct {
	engine *Engine
}

func (t *codeModeTool) Name() string { return codeModeToolName }

func (t *codeModeTool) Description() string {
	return "Runs JavaScript that calls your tools and returns only what the script outputs. Use it instead of several direct calls, or to extract a small part of a large result. See the Code Mode section of the system prompt."
}

func (t *codeModeTool) ParameterSchema() string {
	return `{"type":"object","additionalProperties":false,"properties":{` +
		`"code":{"type":"string","description":"JavaScript, run as the body of an async function: top-level await and return work. Plain JavaScript only, no TypeScript or Markdown fences."}` +
		`},"required":["code"]}`
}

type codeModeCall struct {
	st   *engineLoopState
	step int
	call ToolCall
}

type codeModeCallKey struct{}

func withCodeModeCall(ctx context.Context, call *codeModeCall) context.Context {
	return context.WithValue(ctx, codeModeCallKey{}, call)
}

func (t *codeModeTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	call, _ := ctx.Value(codeModeCallKey{}).(*codeModeCall)
	opts := t.engine.codeMode
	if call == nil || opts == nil {
		return "", fmt.Errorf("codemode is not available here")
	}
	code, ok := params["code"].(string)
	if !ok || strings.TrimSpace(code) == "" {
		return "", fmt.Errorf("code is required and must be a nonempty string")
	}
	host := &codeModeHost{
		e:        t.engine,
		st:       call.st,
		step:     call.step,
		parentID: toolActivityID(call.step, &call.call),
		calls:    map[int]*codeModeOp{},
		selected: map[string]tools.Tool{},
	}
	result := codemode.Run(ctx, code, host, codemode.Limits{
		Timeout:      opts.Timeout,
		MaxToolCalls: opts.MaxToolCalls,
		MaxParallel:  opts.MaxParallelCalls,
	}, codeModeMemory)
	if result.Status == codemode.StatusRequiresDirectCall && result.Pending != nil {
		host.showForDirectCall(result.Pending.Tool)
	}
	call.st.log.Info("codemode_done",
		"step", call.step, "status", string(result.Status), "calls", len(result.Ops),
		"output_items", len(result.Output), "duration_ms", result.Elapsed.Milliseconds(),
		"approx_peak_heap_growth_bytes", result.Memory.PeakHeapGrowthBytes,
		"approx_allocated_bytes", result.Memory.AllocatedBytes)
	observation := formatCodeModeResult(result)
	if result.Status != codemode.StatusCompleted {
		return observation, tools.PreserveObservationError(fmt.Errorf("codemode %s", result.Status))
	}
	return observation, nil
}

type codeModeObservation struct {
	Status      string                `json:"status"`
	Output      []string              `json:"output"`
	Error       string                `json:"error,omitempty"`
	Calls       []codeModeCallSummary `json:"calls,omitempty"`
	PendingCall *codemode.PendingCall `json:"pending_call,omitempty"`
	ElapsedMS   int64                 `json:"elapsed_ms"`
}

type codeModeCallSummary struct {
	Tool    string `json:"tool,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
}

func formatCodeModeResult(r codemode.Result) string {
	out := codeModeObservation{Status: string(r.Status), Output: r.Output, Error: r.Error, PendingCall: r.Pending, ElapsedMS: r.Elapsed.Milliseconds()}
	for _, op := range r.Ops {
		summary := codeModeCallSummary{Tool: op.Tool, Outcome: string(op.Outcome), Error: shorten(op.Error)}
		if op.Kind != codemode.OpCall {
			summary.Kind = string(op.Kind)
			if op.Kind == codemode.OpSearch {
				summary.Tool = op.Query
			}
		}
		out.Calls = append(out.Calls, summary)
	}
	raw, _ := json.Marshal(out)
	return string(raw)
}

// codeModeHost performs one invocation's operations through the engine's own per-call path:
// visibility, repeat limit, guard, hooks, events and redaction. Check and Finish run on the
// invocation's goroutine while the engine loop waits for the codemode call, so they may touch the
// run state; Run may run concurrently and only executes the tool.
type codeModeHost struct {
	e        *Engine
	st       *engineLoopState
	step     int
	parentID string

	mu       sync.Mutex
	calls    map[int]*codeModeOp
	selected map[string]tools.Tool
}

type codeModeOp struct {
	call  ToolCall
	tool  tools.Tool
	key   string
	start time.Time
}

// codeModeExcluded reports tools a script may not call: they change the run's state when they
// finish (plan, reaction, ending the run), run commands, or need approval.
func codeModeExcluded(name string, tool tools.Tool) bool {
	switch normalizedToolName(name) {
	case codeModeToolName, toolSearchToolName, "plan_create", reactionToolName, "bash", "powershell":
		return true
	}
	if guard.RequiresForcedApproval(name) {
		return true
	}
	if stopper, ok := tool.(interface{ StopAfterSuccess() bool }); ok && stopper.StopAfterSuccess() {
		return true
	}
	return false
}

// eligible finds a tool the script may call: visible to the model, or selected by a search in
// this script, and not excluded.
func (h *codeModeHost) eligible(name string) (tools.Tool, string) {
	tool, ok := h.e.registry.Get(name)
	if !ok {
		h.mu.Lock()
		tool, ok = h.selected[name]
		h.mu.Unlock()
		if !ok {
			return nil, fmt.Sprintf("tool %q is not available; use searchTools to find tools", name)
		}
	}
	if codeModeExcluded(name, tool) {
		return nil, fmt.Sprintf("%s cannot be called from a script; call it directly", name)
	}
	if _, visible := h.e.lookupTool(h.st, name); visible {
		return tool, ""
	}
	h.mu.Lock()
	_, selected := h.selected[name]
	h.mu.Unlock()
	if selected {
		return tool, ""
	}
	return nil, fmt.Sprintf("tool %q is not available; use searchTools to find tools", name)
}

func (h *codeModeHost) Check(ctx context.Context, op codemode.Op) codemode.Decision {
	switch op.Kind {
	case codemode.OpSearch:
		return codemode.Decision{Kind: codemode.Allow}
	case codemode.OpDescribe:
		if _, reason := h.eligible(op.Tool); reason != "" {
			return codemode.Decision{Kind: codemode.Reject, Message: reason}
		}
		return codemode.Decision{Kind: codemode.Allow}
	}
	tool, reason := h.eligible(op.Tool)
	if reason != "" {
		return codemode.Decision{Kind: codemode.Reject, Message: reason}
	}
	key := normalizedToolName(op.Tool)
	if limit := h.e.config.ToolRepeatLimit; limit > 0 && key != "" && h.st.toolRunCounts[key] >= limit {
		return codemode.Decision{Kind: codemode.Reject, Message: toolRepeatLimitObservation(op.Tool, limit)}
	}
	call := ToolCall{
		ID:       fmt.Sprintf("%s.%d", h.parentID, op.Index),
		Name:     op.Tool,
		Params:   op.Args,
		ParentID: h.parentID,
	}
	observation, denied, approval, err := h.e.guardDecide(ctx, h.st, h.step, &call, "")
	switch {
	case err != nil:
		return codemode.Decision{Kind: codemode.Reject, Message: err.Error()}
	case denied:
		return codemode.Decision{Kind: codemode.Reject, Message: observation}
	case approval != nil:
		return codemode.Decision{Kind: codemode.RequireApproval, Message: strings.Join(approval.Reasons, "; ")}
	}
	if key != "" {
		h.st.toolRunCounts[key]++
	}
	h.st.log.Info("tool_call", "step", h.step, "tool", op.Tool, "parent", h.parentID,
		"args", toolArgsSummary(op.Tool, op.Args, h.e.logOpts, false))
	if h.e.onToolStart != nil {
		h.e.onToolStart(h.st.agentCtx, op.Tool)
	}
	if h.e.onToolCallStart != nil {
		h.e.onToolCallStart(h.st.agentCtx, call)
	}
	h.mu.Lock()
	h.calls[op.Index] = &codeModeOp{call: call, tool: tool, key: key, start: time.Now()}
	h.mu.Unlock()
	return codemode.Decision{Kind: codemode.Allow}
}

func (h *codeModeHost) ParallelSafe(op codemode.Op) bool {
	switch op.Kind {
	case codemode.OpDescribe:
		return true
	case codemode.OpSearch:
		return false
	}
	tool, ok := h.e.registry.Get(op.Tool)
	if !ok {
		h.mu.Lock()
		tool, ok = h.selected[op.Tool]
		h.mu.Unlock()
	}
	safe, isSafe := tool.(tools.ParallelSafe)
	return ok && isSafe && safe.ParallelSafe()
}

func (h *codeModeHost) Run(ctx context.Context, op codemode.Op) (string, error) {
	switch op.Kind {
	case codemode.OpSearch:
		return h.search(ctx, op)
	case codemode.OpDescribe:
		return h.describe(op.Tool)
	}
	h.mu.Lock()
	nested := h.calls[op.Index]
	h.mu.Unlock()
	return h.e.executeFoundTool(ctx, h.st, h.step, &nested.call, nested.tool)
}

func (h *codeModeHost) Finish(ctx context.Context, op codemode.Op, result string, runErr error) (string, error) {
	if op.Kind != codemode.OpCall {
		return result, runErr
	}
	h.mu.Lock()
	nested := h.calls[op.Index]
	h.mu.Unlock()
	if nested == nil {
		return result, runErr
	}
	call := nested.call
	observation, err, guardErr := h.e.guardPostRedact(ctx, h.st, h.step, &call, result, runErr)
	if guardErr != nil && err == nil {
		err = guardErr
	}
	if err != nil {
		if strings.TrimSpace(observation) == "" {
			observation = err.Error()
		}
		if nested.key != "" && h.st.toolRunCounts[nested.key] > 0 {
			h.st.toolRunCounts[nested.key]--
		}
	}
	// A call from a script never marks its tool as used by the conversation (noteToolUsed): only
	// direct calls keep a found tool visible in later turns.
	if err == nil && h.e.onToolSuccess != nil {
		h.e.onToolSuccess(h.st.agentCtx, call.Name)
	}
	if h.e.onToolCallDone != nil {
		h.e.onToolCallDone(h.st.agentCtx, call, observation, err)
	}
	fields := []any{"step", h.step, "tool", call.Name, "parent", h.parentID,
		"duration_ms", time.Since(nested.start).Milliseconds(), "observation_len", len(observation)}
	if err != nil {
		h.st.log.Warn("tool_done", append(fields, "error", err.Error())...)
	} else {
		h.st.log.Info("tool_done", fields...)
	}
	EmitEvent(context.WithoutCancel(ctx), nil, Event{
		Kind:             EventKindToolDone,
		Step:             h.step,
		ActivityID:       toolActivityID(h.step, &call),
		ParentActivityID: h.parentID,
		ToolName:         strings.TrimSpace(call.Name),
		Status:           toolEventStatus(err),
		Text:             observation,
		Error:            eventErrorString(err),
		Args:             toolDisplayArgsSummary(strings.TrimSpace(call.Name), call.Params, h.e.logOpts),
	})
	if err != nil {
		return "", errors.New(observation)
	}
	return observation, nil
}

type codeModeSearchResult struct {
	Tools   []codeModeSearchTool     `json:"tools"`
	Servers []toolSearchServerResult `json:"servers"`
	HasMore bool                     `json:"has_more"`
	Note    string                   `json:"note,omitempty"`
}

type codeModeSearchTool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Server      string `json:"server,omitempty"`
}

// search finds tools for the script. Without a server it searches the run's eligible tools and the
// catalog's servers, connecting nothing; with one it connects that server. Found hidden tools
// become callable in this script only, never visible to the model.
func (h *codeModeHost) search(ctx context.Context, op codemode.Op) (string, error) {
	query := strings.TrimSpace(op.Query)
	if query == "" {
		return "", fmt.Errorf("searchTools needs a query")
	}
	limit := op.Limit
	if limit <= 0 {
		limit = toolSearchDefaultSize
	}
	if limit > toolSearchMaxSize {
		limit = toolSearchMaxSize
	}
	search := h.st.search
	var matches []toolSearchMatch
	if op.Server != "" {
		if search == nil || search.opts.Catalog == nil {
			return "", fmt.Errorf("no servers can be searched in this run")
		}
		serverTools, err := search.opts.Catalog.ConnectServer(ctx, op.Server)
		if err != nil {
			return "", err
		}
		for _, tool := range serverTools {
			if m, ok := matchTool(query, tool); ok && !codeModeExcluded(tool.Name(), tool) {
				matches = append(matches, m)
			}
		}
	} else {
		for _, tool := range h.e.registry.All() {
			if codeModeExcluded(tool.Name(), tool) {
				continue
			}
			if _, visible := h.e.lookupTool(h.st, tool.Name()); !visible && (search == nil || !search.opts.Hidden(tool)) {
				continue
			}
			if m, ok := matchTool(query, tool); ok {
				matches = append(matches, m)
			}
		}
		if search != nil {
			matches = append(matches, matchServers(search.opts.Catalog, query)...)
		}
	}
	out := codeModeSearchResult{Tools: []codeModeSearchTool{}, Servers: []toolSearchServerResult{}}
	matches, out.HasMore = rankMatches(matches, limit)
	maxSelected := DefaultMaxFoundTools
	if search != nil {
		maxSelected = search.opts.MaxFound
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, m := range matches {
		if !m.isTool {
			out.Servers = append(out.Servers, toolSearchServerResult{Name: m.server.Name, Description: shorten(m.server.Description), Connected: m.server.Connected})
			continue
		}
		name := m.tool.Name()
		if _, visible := h.e.lookupTool(h.st, name); !visible {
			if _, already := h.selected[name]; !already {
				if len(h.selected) >= maxSelected {
					out.Note = fmt.Sprintf("this script already selected %d tools, the most it can", maxSelected)
					continue
				}
				h.selected[name] = m.tool
			}
		}
		server := ""
		if search != nil {
			server = search.serverOf(name)
		}
		out.Tools = append(out.Tools, codeModeSearchTool{Name: name, Description: shorten(m.tool.Description()), Server: server})
	}
	raw, err := json.Marshal(out)
	return string(raw), err
}

func (h *codeModeHost) describe(name string) (string, error) {
	tool, reason := h.eligible(name)
	if reason != "" {
		return "", errors.New(reason)
	}
	schema := json.RawMessage(tool.ParameterSchema())
	if !json.Valid(schema) {
		schema = json.RawMessage(`{}`)
	}
	raw, err := json.Marshal(map[string]any{"name": tool.Name(), "description": tool.Description(), "inputSchema": schema})
	return string(raw), err
}

// showForDirectCall makes a tool the script stopped at visible on the next step, without counting
// it as found by the conversation, so the model can make the call directly.
func (h *codeModeHost) showForDirectCall(name string) {
	search := h.st.search
	if search == nil {
		return
	}
	if _, visible := h.e.lookupTool(h.st, name); visible {
		return
	}
	h.mu.Lock()
	tool, ok := h.selected[name]
	h.mu.Unlock()
	if !ok {
		return
	}
	search.mu.Lock()
	search.handoff = append(search.handoff, tool)
	search.mu.Unlock()
}
