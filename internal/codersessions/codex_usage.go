package codersessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	// CacheCreation splits CacheCreationInputTokens by the cache's lifetime, when the CLI says.
	CacheCreation map[string]int64
	// Responses are the model's responses the usage sums: a list price goes by the single
	// request, so the sum alone cannot be priced.
	Responses []ResponseUsage
}

// ResponseUsage is what one response used; the fields are ModelUsage's.
type ResponseUsage struct {
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	OutputTokens             int64
	CacheCreation            map[string]int64
	// Count is how many such responses.
	Count int64
}

func (u ResponseUsage) zero() bool {
	return u.InputTokens <= 0 && u.OutputTokens <= 0
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
			found, err := findCodexRollout(root, id)
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

// CodexUsageReader retains response offsets across tasks and process restarts. App-server
// supplies execution events; rollouts supply model names and per-response pricing inputs.
type CodexUsageReader struct {
	reader codexUsage
	path   string
}

func NewCodexUsageReader(getenv func(string) string, home, cwd, thread string, resumed bool) *CodexUsageReader {
	path, _ := findCodexRollout(codexRolloutRoot(getenv, home, cwd), thread)
	r := &CodexUsageReader{path: path}
	if resumed && path != "" {
		// A reopened thread's rollouts already hold lines written, and counted or not, before
		// this reader existed: it starts at their end.
		r.reader.read(path)
		r.reader.take()
	}
	return r
}

// Take returns what the thread's rollouts record since the last Take.
func (r *CodexUsageReader) Take(getenv func(string) string, home, cwd, thread string) Usage {
	if r.path == "" {
		r.path, _ = findCodexRollout(codexRolloutRoot(getenv, home, cwd), thread)
	}
	if r.path != "" {
		r.reader.read(r.path)
	}
	return r.reader.take()
}

// codexRolloutRoot is Codex's sessions folder: under CODEX_HOME, else ~/.codex.
func codexRolloutRoot(getenv func(string) string, home, cwd string) string {
	dir := getenv("CODEX_HOME")
	if dir == "" {
		dir = filepath.Join(home, ".codex")
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(cwd, dir)
	}
	return filepath.Join(dir, "sessions")
}

func findCodexRollout(root, id string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(root, "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if err != nil || len(matches) == 0 {
		return "", err
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("Codex has %d session files for %s", len(matches), id)
	}
	return matches[0], nil
}

type codexAgentActivity struct {
	Agent string `json:"agent_thread_id"`
}
type codexEntry struct {
	Type    string `json:"type"`
	Payload struct {
		Type string `json:"type"`
		codexAgentActivity
		Item struct {
			Type string `json:"type"`
			codexAgentActivity
		} `json:"item"`
	} `json:"payload"`
}

func (e codexEntry) agentActivity() (codexAgentActivity, bool) {
	p := e.Payload
	if e.Type == "event_msg" {
		if p.Type == "sub_agent_activity" {
			return p.codexAgentActivity, true
		}
		if p.Type == "item_completed" && p.Item.Type == "SubAgentActivity" {
			return p.Item.codexAgentActivity, true
		}
	}
	return codexAgentActivity{}, false
}
