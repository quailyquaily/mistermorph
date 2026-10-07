package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	toolSearchToolName = "tool_search"
	// DefaultMaxFoundTools bounds how many tools one run can make visible through tool_search.
	DefaultMaxFoundTools  = 20
	toolSearchDefaultSize = 5
	toolSearchMaxSize     = 10
	toolSearchDescription = 200
)

// ToolCatalog is what tool_search can reach beyond the run's visible tools: configured MCP
// servers, and connecting them for the run. The runtime implements it; agent knows no MCP.
type ToolCatalog interface {
	// Servers lists the servers a search may report.
	Servers() []CatalogServer
	// ConnectServer connects a server for this run if needed, and returns its allowed tools.
	ConnectServer(ctx context.Context, name string) ([]tools.Tool, error)
	// LoadTools returns the named tools, connecting their servers as needed. A tool that cannot be
	// loaded is left out; the catalog logs why.
	LoadTools(ctx context.Context, names []string) []tools.Tool
	// ServerOfTool names the server a tool comes from, or "".
	ServerOfTool(name string) string
}

// CatalogServer is a server tool_search may report before or after connecting it.
type CatalogServer struct {
	Name        string
	Description string
	Connected   bool
}

// ToolSearchOptions turn on tool search for a run: tools for which Hidden is true are left out
// of requests and the system prompt until the model finds them with tool_search.
type ToolSearchOptions struct {
	Catalog ToolCatalog
	Hidden  func(tools.Tool) bool
	// Visible names hidden tools that are visible from the first request: always-loaded tools,
	// tools found earlier in the conversation, and tools of servers the task referenced.
	Visible []string
	// MaxFound bounds the tools one run can find; zero uses DefaultMaxFoundTools.
	MaxFound int
}

// WithToolSearch enables tool search. Without it every registered tool is visible, as before.
func WithToolSearch(opts ToolSearchOptions) Option {
	return func(e *Engine) {
		if opts.Hidden == nil {
			return
		}
		if opts.MaxFound <= 0 {
			opts.MaxFound = DefaultMaxFoundTools
		}
		e.toolSearch = &opts
	}
}

const toolSearchPromptBlock = `[[ Tool Search ]]
- More tools than the ones listed are available. Call ` + "`tool_search`" + ` with words describing what you need, or with an exact tool name, to find them.
- Before answering that you cannot do something or do not know something, search with tool_search when one of the servers below might help.
- A tool that tool_search finds can be called from your next step, not in the same response.
- A server result means the server may have what you need: call tool_search again with its name as ` + "`server`" + ` to see its tools.
- If nothing is found, retry with likely tool names or other words before giving up.`

// maxPromptServers bounds how many servers the tool search block names.
const maxPromptServers = 20

// toolSearchPrompt is the tool search block, naming the servers a search can reach with their
// descriptions, so the model knows when searching may help. Tool names stay out of the prompt.
func toolSearchPrompt(catalog ToolCatalog) string {
	if catalog == nil {
		return toolSearchPromptBlock
	}
	servers := catalog.Servers()
	if len(servers) == 0 {
		return toolSearchPromptBlock
	}
	lines := []string{toolSearchPromptBlock, "- Servers you can search:"}
	for i, server := range servers {
		if i == maxPromptServers {
			lines = append(lines, fmt.Sprintf("  - … and %d more; search to find them.", len(servers)-maxPromptServers))
			break
		}
		line := "  - " + server.Name
		if description := shorten(server.Description); description != "" {
			line += ": " + description
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// runToolSearch is one run's tool visibility. visible changes only between steps; tools found
// during a step wait in pending.
type runToolSearch struct {
	opts *ToolSearchOptions

	mu      sync.Mutex
	visible map[string]bool
	pending []tools.Tool
	// handoff are tools a codemode script stopped at for approval: visible on the next step so
	// the model can call them directly, without counting as found.
	handoff []tools.Tool
	found   []string
	touched []string
}

type toolSearchContextKey struct{}

func withRunToolSearch(ctx context.Context, search *runToolSearch) context.Context {
	// Always set, even to nil, so a subtask's run never sees its parent's search state.
	return context.WithValue(ctx, toolSearchContextKey{}, search)
}

func runToolSearchFrom(ctx context.Context) *runToolSearch {
	search, _ := ctx.Value(toolSearchContextKey{}).(*runToolSearch)
	return search
}

// startToolSearch builds a run's visible set: every tool that is not hidden, plus the hidden
// tools named in names, loading through the catalog those the registry does not have yet.
func (e *Engine) startToolSearch(ctx context.Context, names []string, found []string) *runToolSearch {
	if e.toolSearch == nil {
		return nil
	}
	search := &runToolSearch{opts: e.toolSearch, visible: make(map[string]bool)}
	var missing []string
	for _, name := range dedupeNames(names) {
		if _, ok := e.registry.Get(name); !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 && e.toolSearch.Catalog != nil {
		for _, tool := range e.toolSearch.Catalog.LoadTools(ctx, missing) {
			if _, exists := e.registry.Get(tool.Name()); !exists {
				_ = e.registry.Register(tool)
			}
		}
	}
	for _, tool := range e.registry.All() {
		if !e.toolSearch.Hidden(tool) {
			search.visible[tool.Name()] = true
		}
	}
	for _, name := range dedupeNames(names) {
		if _, ok := e.registry.Get(name); ok {
			search.visible[name] = true
		} else {
			e.log.Info("tool_search_initial_tool_unavailable", "tool", name)
		}
	}
	search.found = dedupeNames(found)
	return search
}

func dedupeNames(names []string) []string {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// visibleRegistry is the registry as the model may see it: everything without tool search,
// otherwise only the visible tools.
func (e *Engine) visibleRegistry(search *runToolSearch) *tools.Registry {
	if search == nil {
		return e.registry
	}
	out := tools.NewRegistry()
	search.mu.Lock()
	defer search.mu.Unlock()
	for _, tool := range e.registry.All() {
		if search.visible[tool.Name()] {
			_ = out.Register(tool)
		}
	}
	return out
}

// lookupTool finds a tool the model may call: registered and, with tool search, visible.
func (e *Engine) lookupTool(st *engineLoopState, name string) (tools.Tool, bool) {
	tool, ok := e.registry.Get(name)
	if !ok || st == nil || st.search == nil {
		return tool, ok
	}
	st.search.mu.Lock()
	defer st.search.mu.Unlock()
	return tool, st.search.visible[name]
}

// unknownToolMessage tells the model a tool is not callable, listing only what it may call.
func (e *Engine) unknownToolMessage(st *engineLoopState, name string) string {
	if st == nil || st.search == nil {
		return fmt.Sprintf("Error: tool '%s' not found. Available tools: %s", name, e.registry.ToolNames())
	}
	return fmt.Sprintf("Error: tool '%s' is not available. Available tools: %s. Use %s to find other tools; a found tool can be called from the next step.",
		name, e.visibleRegistry(st.search).ToolNames(), toolSearchToolName)
}

// noteToolUsed records a hidden tool the run called, so the conversation keeps it.
func (st *engineLoopState) noteToolUsed(e *Engine, name string) {
	if st == nil || st.search == nil {
		return
	}
	tool, ok := e.registry.Get(name)
	if !ok || !st.search.opts.Hidden(tool) {
		return
	}
	st.search.mu.Lock()
	st.search.touched = append(st.search.touched, name)
	st.search.mu.Unlock()
}

// applyFoundTools makes the tools found during the last step visible, rebuilds the request
// tools, and records them on the run context.
func (e *Engine) applyFoundTools(st *engineLoopState) {
	if st == nil || st.search == nil {
		return
	}
	search := st.search
	search.mu.Lock()
	pending := search.pending
	search.pending = nil
	added := make([]string, 0, len(pending)+len(search.handoff))
	for _, tool := range search.handoff {
		name := tool.Name()
		if search.visible[name] {
			continue
		}
		if _, exists := e.registry.Get(name); !exists {
			if err := e.registry.Register(tool); err != nil {
				st.log.Warn("codemode_handoff_register_failed", "tool", name, "error", err.Error())
				continue
			}
		}
		search.visible[name] = true
		added = append(added, name)
	}
	search.handoff = nil
	for _, tool := range pending {
		name := tool.Name()
		if search.visible[name] {
			continue
		}
		if _, exists := e.registry.Get(name); !exists {
			if err := e.registry.Register(tool); err != nil {
				st.log.Warn("tool_search_register_failed", "tool", name, "error", err.Error())
				continue
			}
		}
		search.visible[name] = true
		search.found = append(search.found, name)
		search.touched = append(search.touched, name)
		added = append(added, name)
	}
	search.mu.Unlock()
	if len(added) > 0 {
		st.tools = buildLLMTools(e.visibleRegistry(search))
		st.log.Info("tool_search_tools_visible", "added", added, "visible_count", len(st.tools))
	}
	st.agentCtx.FoundTools = search.conversationTools()
}

// conversationTools are the hidden tools this run found or used, most recent first, for the
// conversation to keep.
func (s *runToolSearch) conversationTools() []string {
	order := append(append([]string(nil), s.found...), s.touched...)
	out := make([]string, 0, len(order))
	seen := make(map[string]bool, len(order))
	for i := len(order) - 1; i >= 0; i-- {
		if name := order[i]; !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

func (s *runToolSearch) visibleNames() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.visible))
	for name := range s.visible {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// toolSearchTool is tool_search. It reads the run's state from the context, so one tool serves
// every run of the engine.
type toolSearchTool struct {
	engine *Engine
}

func (t *toolSearchTool) Name() string { return toolSearchToolName }

func (t *toolSearchTool) Description() string {
	return "Finds more tools by name or description. Found tools can be called from the next step. A server result means you can search again within that server."
}

func (t *toolSearchTool) ParameterSchema() string {
	return `{"type":"object","additionalProperties":false,"properties":{` +
		`"query":{"type":"string","description":"An exact tool name, or words describing what you need."},` +
		`"server":{"type":"string","description":"Optional server name from an earlier result; searches only that server, connecting it if needed."},` +
		`"limit":{"type":"integer","minimum":1,"maximum":10,"description":"Maximum results, default 5."}` +
		`},"required":["query"]}`
}

type toolSearchToolResult struct {
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	Server         string `json:"server,omitempty"`
	AlreadyVisible bool   `json:"already_visible"`
}

type toolSearchServerResult struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Connected   bool   `json:"connected"`
}

type toolSearchOutput struct {
	Tools   []toolSearchToolResult   `json:"tools"`
	Servers []toolSearchServerResult `json:"servers"`
	HasMore bool                     `json:"has_more"`
	Note    string                   `json:"note,omitempty"`
}

type toolSearchMatch struct {
	class   int
	matched int
	isTool  bool
	name    string
	tool    tools.Tool
	server  CatalogServer
}

func (t *toolSearchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	search := runToolSearchFrom(ctx)
	if search == nil {
		return "", fmt.Errorf("tool_search is not available in this run")
	}
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query is required (retrying with a query will work)")
	}
	server, _ := params["server"].(string)
	server = strings.TrimSpace(server)
	limit := toolSearchDefaultSize
	if raw, ok := params["limit"]; ok {
		n, ok := toInt(raw)
		if !ok || n < 1 || n > toolSearchMaxSize {
			return "", fmt.Errorf("limit must be an integer from 1 to %d", toolSearchMaxSize)
		}
		limit = n
	}

	var matches []toolSearchMatch
	if server != "" {
		catalog := search.opts.Catalog
		if catalog == nil {
			return "", fmt.Errorf("no servers can be searched in this run")
		}
		serverTools, err := catalog.ConnectServer(ctx, server)
		if err != nil {
			return "", fmt.Errorf("%v (retrying may help if the server was briefly unreachable)", err)
		}
		for _, tool := range serverTools {
			if m, ok := matchTool(query, tool); ok {
				matches = append(matches, m)
			}
		}
	} else {
		for _, tool := range t.engine.registry.All() {
			if !search.opts.Hidden(tool) {
				continue
			}
			if m, ok := matchTool(query, tool); ok {
				matches = append(matches, m)
			}
		}
		matches = append(matches, matchServers(search.opts.Catalog, query)...)
	}
	out := toolSearchOutput{Tools: []toolSearchToolResult{}, Servers: []toolSearchServerResult{}}
	matches, out.HasMore = rankMatches(matches, limit)

	search.mu.Lock()
	room := search.opts.MaxFound - len(search.found) - len(search.pending)
	pendingNames := make(map[string]bool, len(search.pending))
	for _, tool := range search.pending {
		pendingNames[tool.Name()] = true
	}
	for _, m := range matches {
		if !m.isTool {
			out.Servers = append(out.Servers, toolSearchServerResult{Name: m.server.Name, Description: shorten(m.server.Description), Connected: m.server.Connected})
			continue
		}
		name := m.tool.Name()
		already := search.visible[name] || pendingNames[name]
		if !already {
			if room <= 0 {
				out.Note = fmt.Sprintf("This run has already found %d tools, the most it can; work with the tools you have.", search.opts.MaxFound)
				continue
			}
			search.pending = append(search.pending, m.tool)
			pendingNames[name] = true
			room--
		}
		out.Tools = append(out.Tools, toolSearchToolResult{Name: name, Description: shorten(m.tool.Description()), Server: search.serverOf(name), AlreadyVisible: already})
	}
	search.mu.Unlock()

	data, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// matchServers are the catalog's servers that match query.
func matchServers(catalog ToolCatalog, query string) []toolSearchMatch {
	if catalog == nil {
		return nil
	}
	var out []toolSearchMatch
	for _, srv := range catalog.Servers() {
		if class, matched, ok := matchText(query, srv.Name, srv.Description); ok {
			out = append(out, toolSearchMatch{class: class, matched: matched, name: srv.Name, server: srv})
		}
	}
	return out
}

// rankMatches orders matches best first and keeps at most limit; hasMore reports a cut.
func rankMatches(matches []toolSearchMatch, limit int) ([]toolSearchMatch, bool) {
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.class != b.class {
			return a.class < b.class
		}
		if a.matched != b.matched {
			return a.matched > b.matched
		}
		if a.isTool != b.isTool {
			return a.isTool
		}
		return a.name < b.name
	})
	if len(matches) > limit {
		return matches[:limit], true
	}
	return matches, false
}

func (s *runToolSearch) serverOf(name string) string {
	if s.opts.Catalog == nil {
		return ""
	}
	return s.opts.Catalog.ServerOfTool(name)
}

func matchTool(query string, tool tools.Tool) (toolSearchMatch, bool) {
	name := tool.Name()
	class, matched, ok := matchText(query, name, tool.Description())
	if !ok {
		return toolSearchMatch{}, false
	}
	return toolSearchMatch{class: class, matched: matched, isTool: true, name: name, tool: tool}, true
}

// matchText ranks a query against a name and description: 0 for the exact name, 1 for a name
// prefix, 2 when every query word appears, 3 when some do. matched counts the words found.
func matchText(query, name, description string) (int, int, bool) {
	q := strings.ToLower(strings.TrimSpace(query))
	lowerName := strings.ToLower(name)
	if q == lowerName {
		return 0, 1, true
	}
	if strings.HasPrefix(lowerName, q) {
		return 1, 1, true
	}
	words := searchWords(q)
	if len(words) == 0 {
		return 0, 0, false
	}
	haystack := " " + strings.Join(searchWords(name+" "+description), " ") + " "
	matched := 0
	for _, word := range words {
		if strings.Contains(haystack, word) {
			matched++
		}
	}
	switch {
	case matched == 0:
		return 0, 0, false
	case matched == len(words):
		return 2, matched, true
	default:
		return 3, matched, true
	}
}

// searchWords lower-cases text and splits it at anything that is not a letter or digit, so
// "get_issue" and "get issue" match.
func searchWords(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

func shorten(text string) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) <= toolSearchDescription {
		return text
	}
	return string(runes[:toolSearchDescription]) + "…"
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n != float64(int(n)) {
			return 0, false
		}
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	}
	return 0, false
}

// llmToolsForRun are the tools a run's requests carry.
func (e *Engine) llmToolsForRun(search *runToolSearch) []llm.Tool {
	return buildLLMTools(e.visibleRegistry(search))
}
