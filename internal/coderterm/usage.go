package coderterm

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ModelUsage is what a task used of one model. InputTokens counts every input token, cached reads
// and cache writes included.
type ModelUsage struct {
	Model                    string
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	OutputTokens             int64
	ReasoningTokens          int64
	// CacheCreation splits CacheCreationInputTokens by the cache's lifetime, under the CLI's own
	// names (Claude Code: ephemeral_5m_input_tokens, ephemeral_1h_input_tokens), when it says.
	CacheCreation map[string]int64
	// Responses are the model's responses the usage sums, when the CLI's files tell them apart
	// (Claude Code): a list price goes by the single request, so the sum alone cannot be priced.
	Responses []ResponseUsage
}

// ResponseUsage is what one response used; the fields are ModelUsage's.
type ResponseUsage struct {
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	OutputTokens             int64
	CacheCreation            map[string]int64
	// Count is 1, or -1 for a response an earlier task of the session reported with these
	// numbers and this task reports again with corrected ones.
	Count int64
}

func (u ResponseUsage) same(o ResponseUsage) bool {
	return u.InputTokens == o.InputTokens && u.CachedInputTokens == o.CachedInputTokens &&
		u.CacheCreationInputTokens == o.CacheCreationInputTokens && u.OutputTokens == o.OutputTokens &&
		maps.Equal(u.CacheCreation, o.CacheCreation)
}

func (u ResponseUsage) zero() bool {
	return u.InputTokens <= 0 && u.OutputTokens <= 0
}

func (u *ModelUsage) add(o ModelUsage) {
	u.InputTokens += o.InputTokens
	u.CachedInputTokens += o.CachedInputTokens
	u.CacheCreationInputTokens += o.CacheCreationInputTokens
	u.OutputTokens += o.OutputTokens
	u.ReasoningTokens += o.ReasoningTokens
}

func (u ModelUsage) zero() bool {
	return u.InputTokens <= 0 && u.OutputTokens <= 0
}

// Usage is what one task used, as the CLI's session files record it: per model, and the number of
// turns that ended.
type Usage struct {
	Models []ModelUsage
	Turns  int
}

// usageReader counts the usage a session's files record. It keeps its own offset per file, apart
// from the turn reader's, so each line is counted once over the tasks of a session and what the
// CLI wrote between two tasks is counted with the later one. It never fails a task: a file it
// cannot read, or a line it cannot parse, is left out.
type usageReader interface {
	// read counts what the session's file at path, and its sub-agents' files, hold past their
	// offsets. Only complete lines are taken; a partial last line waits for the next read.
	read(path string)
	// take returns what was counted since the last take.
	take() Usage
}

// usageFile is how far one file was counted.
type usageFile struct {
	offset int64
}

// usageLines hands each complete line of path past f.offset to fn and advances the offset. A file
// shorter than the offset was cut or replaced: it is not counted again, and reading goes on from
// its end.
func usageLines(path string, f *usageFile, fn func(line []byte)) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return
	}
	if info.Size() < f.offset {
		f.offset = info.Size()
		return
	}
	if _, err := file.Seek(f.offset, io.SeekStart); err != nil {
		return
	}
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return // The end, or a partial last line: it waits for the next read.
		}
		f.offset += int64(len(line))
		fn(line)
	}
}

// usageTotals sums usage per model for one task.
type usageTotals struct {
	models map[string]*ModelUsage
	turns  int
}

func (t *usageTotals) model(name string) *ModelUsage {
	if t.models == nil {
		t.models = map[string]*ModelUsage{}
	}
	m := t.models[name]
	if m == nil {
		m = &ModelUsage{Model: name}
		t.models[name] = m
	}
	return m
}

// response adds one response to its model and returns where it is kept, for replace.
func (t *usageTotals) response(model string, usage ResponseUsage) int {
	m := t.model(model)
	m.Responses = append(m.Responses, usage)
	return len(m.Responses) - 1
}

// replace puts a response's later numbers in place of the ones response kept at index.
func (t *usageTotals) replace(model string, index int, usage ResponseUsage) {
	if m := t.models[model]; m != nil && index < len(m.Responses) {
		m.Responses[index] = usage
	}
}

func (t *usageTotals) take() Usage {
	out := Usage{Turns: t.turns}
	for _, m := range t.models {
		// A model counted by its responses is their sum.
		responses := m.Responses
		m.Responses = nil
		for _, r := range responses {
			if r.zero() || r.Count == 0 {
				continue // a response whose later line moved it to another model
			}
			m.Responses = append(m.Responses, r)
			m.InputTokens += r.Count * r.InputTokens
			m.CachedInputTokens += r.Count * r.CachedInputTokens
			m.CacheCreationInputTokens += r.Count * r.CacheCreationInputTokens
			m.OutputTokens += r.Count * r.OutputTokens
			for key, tokens := range r.CacheCreation {
				if m.CacheCreation == nil {
					m.CacheCreation = map[string]int64{}
				}
				m.CacheCreation[key] += r.Count * tokens
			}
		}
		// A later line of a message can correct an earlier one downward across two tasks.
		m.InputTokens = max(m.InputTokens, 0)
		m.CachedInputTokens = max(m.CachedInputTokens, 0)
		m.CacheCreationInputTokens = max(m.CacheCreationInputTokens, 0)
		m.OutputTokens = max(m.OutputTokens, 0)
		m.ReasoningTokens = max(m.ReasoningTokens, 0)
		for key, tokens := range m.CacheCreation {
			if tokens <= 0 {
				delete(m.CacheCreation, key)
			}
		}
		if len(m.CacheCreation) == 0 {
			m.CacheCreation = nil
		}
		if !m.zero() {
			out.Models = append(out.Models, *m)
		}
	}
	sort.Slice(out.Models, func(i, j int) bool { return out.Models[i].Model < out.Models[j].Model })
	t.models, t.turns = nil, 0
	return out
}

// claudeUsage reads Claude Code's transcript and its sub-agents' files
// (<session id>/subagents/agent-*.jsonl beside it). Every assistant line carries its response's
// usage, and one response is written as several lines (one per content block) with the same
// message ID: a response counts once, by its last line. The responses are kept apart, not only
// summed, since each is priced as the request it was.
type claudeUsage struct {
	files  map[string]*usageFile
	seen   map[string]claudeCounted // by message ID, over all the session's files
	ended  map[string]bool          // messages a turn ended on
	task   int                      // counts the takes: which task a response was counted in
	totals usageTotals
}

type claudeCounted struct {
	model string
	usage ResponseUsage
	task  int // the task that counted it
	index int // where that task's totals keep it
}

func (claudeBackend) newUsage() usageReader { return &claudeUsage{} }

func (r *claudeUsage) take() Usage {
	r.task++
	return r.totals.take()
}

func (r *claudeUsage) file(path string) *usageFile {
	if r.files == nil {
		r.files = map[string]*usageFile{}
	}
	f := r.files[path]
	if f == nil {
		f = &usageFile{}
		r.files[path] = f
	}
	return f
}

func (r *claudeUsage) read(path string) {
	if path == "" {
		return
	}
	usageLines(path, r.file(path), func(line []byte) { r.line(line, true) })
	agents := filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents")
	var files []string
	_ = filepath.WalkDir(agents, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if name := d.Name(); !d.IsDir() && strings.HasPrefix(name, "agent-") && strings.HasSuffix(name, ".jsonl") {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	for _, p := range files {
		usageLines(p, r.file(p), func(line []byte) { r.line(line, false) })
	}
}

func (r *claudeUsage) line(line []byte, main bool) {
	var entry struct {
		Type      string `json:"type"`
		Sidechain bool   `json:"isSidechain"`
		Message   struct {
			ID         string `json:"id"`
			Model      string `json:"model"`
			StopReason string `json:"stop_reason"`
			Usage      *struct {
				Input      int64 `json:"input_tokens"`
				CacheRead  int64 `json:"cache_read_input_tokens"`
				CacheWrite int64 `json:"cache_creation_input_tokens"`
				Output     int64 `json:"output_tokens"`
				// The cache writes by lifetime: ephemeral_5m_input_tokens and
				// ephemeral_1h_input_tokens, which have different prices.
				CacheCreation map[string]any `json:"cache_creation"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Type != "assistant" {
		return
	}
	m := entry.Message
	if main && !entry.Sidechain && (m.StopReason == "end_turn" || m.StopReason == "stop_sequence") {
		if m.ID == "" {
			r.totals.turns++
		} else if !r.ended[m.ID] {
			if r.ended == nil {
				r.ended = map[string]bool{}
			}
			r.ended[m.ID] = true
			r.totals.turns++
		}
	}
	model := strings.TrimSpace(m.Model)
	// Claude Code writes its own notices (an API error) as messages of the model "<synthetic>".
	if m.Usage == nil || model == "" || strings.HasPrefix(model, "<") {
		return
	}
	read, write := max(m.Usage.CacheRead, 0), max(m.Usage.CacheWrite, 0)
	usage := ResponseUsage{
		InputTokens:              max(m.Usage.Input, 0) + read + write,
		CachedInputTokens:        read,
		CacheCreationInputTokens: write,
		OutputTokens:             max(m.Usage.Output, 0),
		CacheCreation:            claudeCacheCreation(m.Usage.CacheCreation, write),
		Count:                    1,
	}
	if m.ID == "" {
		r.totals.response(model, usage)
		return
	}
	before, counted := r.seen[m.ID]
	switch {
	case !counted:
		before = claudeCounted{index: r.totals.response(model, usage)}
	case before.model == model && before.usage.same(usage):
		// Another content block of the response, or its copy in another file.
		return
	case before.task == r.task && before.model == model:
		r.totals.replace(model, before.index, usage)
	case before.task == r.task:
		r.totals.replace(before.model, before.index, ResponseUsage{})
		before.index = r.totals.response(model, usage)
	default:
		// An earlier task reported the response with other numbers: this one takes those back
		// and counts the corrected response, so the two tasks together count it once.
		taken := before.usage
		taken.Count = -1
		r.totals.response(before.model, taken)
		before.index = r.totals.response(model, usage)
	}
	if r.seen == nil {
		r.seen = map[string]claudeCounted{}
	}
	r.seen[m.ID] = claudeCounted{model: model, usage: usage, task: r.task, index: before.index}
}

// claudeCacheCreation reads a usage's cache_creation object: its counts by lifetime. A split
// that does not fit in the cache writes it splits is left out.
func claudeCacheCreation(raw map[string]any, write int64) map[string]int64 {
	var out map[string]int64
	var sum int64
	for key, value := range raw {
		tokens, ok := value.(float64)
		if key = strings.TrimSpace(key); !ok || tokens < 1 || key == "" {
			continue
		}
		if out == nil {
			out = map[string]int64{}
		}
		out[key] = int64(tokens)
		sum += int64(tokens)
	}
	if sum > write {
		return nil
	}
	return out
}

// codexUsageModel is the model Codex usage is recorded under when its rollout named none before
// the response (a rollout of a Codex that writes no turn_context).
const codexUsageModel = "codex"

// codexUsage reads Codex's rollout and its sub-agents' rollouts under the same sessions folder.
// Each token_count line carries the thread's running total and what the last response used; the
// last ones are kept one by one, as a list price goes by the single request. Codex repeats a
// token_count when only its rate limits changed, so a line whose running total is the one before
// it is not counted. A response's model is the one of the thread's last turn_context line, which
// Codex writes at the start of each turn (the model can change between turns).
type codexUsage struct {
	files  map[string]*codexUsageFile // by thread ID
	order  []string                   // thread IDs, in the order they were found
	totals usageTotals
}

type codexUsageFile struct {
	usageFile
	path  string
	total codexTokens // the running total last seen
	model string      // the model of the thread's last turn_context
}

type codexTokens struct {
	Input      int64 `json:"input_tokens"`
	Cached     int64 `json:"cached_input_tokens"`
	CacheWrite int64 `json:"cache_write_input_tokens"`
	Output     int64 `json:"output_tokens"`
	Reasoning  int64 `json:"reasoning_output_tokens"`
}

func (codexBackend) newUsage() usageReader { return &codexUsage{} }

func (r *codexUsage) take() Usage { return r.totals.take() }

// codexThread is the thread ID in a rollout's name, rollout-YYYY-MM-DDThh-mm-ss-<thread ID>.jsonl.
func codexThread(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if len(name) > len("rollout-2006-01-02T15-04-05-") {
		return name[len("rollout-2006-01-02T15-04-05-"):]
	}
	return ""
}

func (r *codexUsage) thread(id string) *codexUsageFile {
	if r.files == nil {
		r.files = map[string]*codexUsageFile{}
	}
	f := r.files[id]
	if f == nil {
		f = &codexUsageFile{}
		r.files[id] = f
		r.order = append(r.order, id)
	}
	return f
}

func (r *codexUsage) read(path string) {
	if path == "" {
		return
	}
	parent := codexThread(path)
	if parent == "" {
		return
	}
	r.thread(parent).path = path
	// path is <sessions>/YYYY/MM/DD/rollout-*.jsonl.
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(path))))
	// The list grows while it is read: a sub-agent's own sub-agents join it.
	for i := 0; i < len(r.order); i++ {
		id := r.order[i]
		f := r.files[id]
		if f.path == "" {
			// Codex may create a sub-agent's rollout late, or never: look again at each read.
			found, err := codexBackend{}.findTranscript(root, id)
			if err != nil || found == "" {
				continue
			}
			f.path = found
		}
		usageLines(f.path, &f.usageFile, func(line []byte) { r.line(line, f, id == parent) })
	}
}

func (r *codexUsage) line(line []byte, f *codexUsageFile, main bool) {
	if bytes.Contains(line, []byte(`"turn_context"`)) {
		var context struct {
			Type    string `json:"type"`
			Payload struct {
				Model string `json:"model"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &context) == nil && context.Type == "turn_context" {
			if model := strings.TrimSpace(context.Payload.Model); model != "" {
				f.model = model
			}
			return
		}
	}
	if !bytes.Contains(line, []byte(`"event_msg"`)) {
		return
	}
	var entry codexEntry
	if json.Unmarshal(line, &entry) != nil || entry.Type != "event_msg" {
		return
	}
	// A sub-agent this thread started or messaged: its rollout is the session's too.
	if activity, ok := entry.agentActivity(); ok && activity.Agent != "" {
		r.thread(activity.Agent)
		return
	}
	switch entry.Payload.Type {
	case "task_complete":
		if main {
			r.totals.turns++
		}
	case "token_count":
		var count struct {
			Payload struct {
				Info *struct {
					Total *codexTokens `json:"total_token_usage"`
					Last  *codexTokens `json:"last_token_usage"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &count) != nil {
			return
		}
		info := count.Payload.Info
		if info == nil || info.Last == nil {
			return
		}
		if info.Total != nil {
			repeated := *info.Total == f.total && *info.Total != (codexTokens{})
			f.total = *info.Total
			if repeated {
				return
			}
		}
		last := info.Last
		model := f.model
		if model == "" {
			model = codexUsageModel
		}
		r.totals.response(model, ResponseUsage{
			InputTokens:              max(last.Input, 0),
			CachedInputTokens:        max(last.Cached, 0),
			CacheCreationInputTokens: max(last.CacheWrite, 0),
			OutputTokens:             max(last.Output, 0),
			Count:                    1,
		})
		r.totals.model(model).ReasoningTokens += max(last.Reasoning, 0)
	}
}

// CodexThreadUsage is what a Codex thread and its sub-agents used, read from their rollouts under
// the sessions folder of the Codex config directory (CODEX_HOME in getenv, else home/.codex): a
// headless run's, whose stream gives only each turn's sum and no model. ok is false when the
// thread has no rollout there or it holds no usage.
func CodexThreadUsage(getenv func(string) string, home, cwd, thread string) (usage Usage, ok bool) {
	thread = strings.TrimSpace(thread)
	if thread == "" {
		return Usage{}, false
	}
	backend := codexBackend{}
	path, err := backend.findTranscript(backend.transcriptRoot(getenv, home, cwd), thread)
	if err != nil || path == "" {
		return Usage{}, false
	}
	reader := &codexUsage{}
	reader.read(path)
	usage = reader.take()
	return usage, len(usage.Models) > 0
}

// baselineUsage starts a reader at the end of what a reopened session's files already hold: those
// lines were written, and counted or not, before this reader existed.
func baselineUsage(r usageReader, path string) {
	if r == nil || path == "" {
		return
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return
	}
	r.read(path)
	r.take()
}
