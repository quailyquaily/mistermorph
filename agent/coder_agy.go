package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
)

// The Antigravity CLI's stream (`agy --output-format stream-json`, agy 1.5.9): one JSON object per
// line, `init`, then a `step_update` per step transition and text delta, then one `result`.
//
//	{"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[…],"permission_mode":"always-proceed"}}
//	{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"…"}}
//	{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{…}}}
//	{"event":"result","result":{"status":"SUCCESS","response":"…","num_turns":1,"usage":{…}}}
//
// agy exits 0 for a run whose actions were denied and for one that answered nothing, so the result
// is read, not the exit code alone.

// agyStreamState is what the collector keeps of an agy stream.
type agyStreamState struct {
	// resultSeen says the stream ended with its result; resultErr why that result is a failure.
	resultSeen bool
	resultErr  string
	// malformed is the first line that was not JSON, shortened.
	malformed string
	// total is the result's usage, steps the sum of the finished steps' (for a run that ended
	// without a result). They are never added together: the result's is the run's total.
	total, steps coderusage.ModelUsage
	hasTotal     bool
	turns        int
	// lastStep and lastState are the last tool step announced; textStep the step of the last text.
	lastStep  int
	lastState string
	textStep  int
	subagents map[string]bool
}

func (c *coderStreamCollector) consumeAgy(payload map[string]any) {
	switch stringField(payload, "event") {
	case "init":
		c.step = coderStepStarting
		c.agy.lastStep, c.agy.textStep = -1, -1
		summary := "[agy] started"
		if init, ok := mapField(payload, "init"); ok {
			if mode := stringField(init, "permission_mode"); mode != "" {
				summary += " (permission mode " + mode + ")"
			}
		}
		c.emitActivity(summary)
	case "step_update":
		if step, ok := mapField(payload, "step_update"); ok {
			c.consumeAgyStep(step)
		}
	case "result":
		if result, ok := mapField(payload, "result"); ok {
			c.consumeAgyResult(result)
		}
	}
}

func (c *coderStreamCollector) consumeAgyStep(step map[string]any) {
	index := -1
	if raw, ok := step["step_index"].(float64); ok {
		index = int(raw)
	}
	state := stringField(step, "state")
	c.announceAgySubagents(index, step["subagent_info"])
	switch stringField(step, "step_type") {
	case "user_input":
		if state == "DONE" {
			c.step = coderStepThinking
			c.emitActivity("[agy] thinking")
		}
	case "agent_response":
		// The delta is taken as written: its spaces and line ends are the answer's.
		if text, _ := step["text_delta"].(string); text != "" {
			if c.agy.textStep != index && c.emitted.Len() > 0 && !strings.HasSuffix(c.emitted.String(), "\n") {
				c.addDelta("\n")
			}
			c.agy.textStep = index
			c.addDelta(text)
		}
		if usage, ok := mapField(step, "usage"); ok && state == "DONE" {
			used := coderusage.AgyUsage(usage)
			c.agy.steps.Model = used.Model
			c.agy.steps.InputTokens += used.InputTokens
			c.agy.steps.CachedInputTokens += used.CachedInputTokens
			c.agy.steps.OutputTokens += used.OutputTokens
			c.agy.steps.ReasoningTokens += used.ReasoningTokens
		}
	case "tool":
		c.consumeAgyToolStep(index, state, step)
	case "checkpoint":
		if state == "DONE" {
			c.emitActivity(fmt.Sprintf("[agy] checkpoint (step %d)", index))
		}
	}
}

// consumeAgyToolStep says a tool step in a line when it starts (its name and what it runs) and
// when it ends (its output, or why it failed). A step repeated in the same state is said once.
func (c *coderStreamCollector) consumeAgyToolStep(index int, state string, step map[string]any) {
	if c.agy.lastStep == index && c.agy.lastState == state {
		return
	}
	c.agy.lastStep, c.agy.lastState = index, state
	info, _ := mapField(step, "tool_info")
	name := firstNonEmptyString(stringField(step, "tool_name"), stringField(info, "name"), "tool")
	if state != "DONE" {
		c.step = agyToolStep(name)
		c.emitActivity(fmt.Sprintf("[agy] %s (step %d)", name, index), agyToolDetail(info))
		return
	}
	// A finished step hands control back to the model.
	c.step = coderStepThinking
	if failure, ok := mapField(info, "error"); ok {
		detail := strings.TrimSpace(stringField(failure, "type") + ": " + stringField(failure, "message"))
		c.emitActivity(fmt.Sprintf("[agy] %s failed (step %d)", name, index), strings.Trim(detail, ": "))
		return
	}
	output, _ := info["output"].(string)
	c.emitActivity(fmt.Sprintf("[agy] %s completed (step %d)", name, index), strings.TrimSpace(output))
}

// announceAgySubagents says each sub-agent a step names, once. The docs give `subagent_info` its
// fields (type_name, role, conversation_id, …) without its shape, and no real one was seen: an
// object, a list of them, and an object holding such a list are all read.
func (c *coderStreamCollector) announceAgySubagents(index int, raw any) {
	for _, agent := range agySubagents(raw) {
		name := firstNonEmptyString(stringField(agent, "type_name"), stringField(agent, "name"), "subagent")
		key := firstNonEmptyString(stringField(agent, "conversation_id"), fmt.Sprintf("%d/%s/%s", index, name, stringField(agent, "role")))
		if c.agy.subagents[key] {
			continue
		}
		if c.agy.subagents == nil {
			c.agy.subagents = map[string]bool{}
		}
		c.agy.subagents[key] = true
		summary := "[agy] subagent " + name
		if role := stringField(agent, "role"); role != "" {
			summary += " (" + role + ")"
		}
		c.step = coderStepSubagent
		c.emitActivity(summary)
	}
}

func agySubagents(raw any) []map[string]any {
	switch value := raw.(type) {
	case []any:
		var out []map[string]any
		for _, item := range value {
			if agent, ok := item.(map[string]any); ok {
				out = append(out, agent)
			}
		}
		return out
	case map[string]any:
		if stringField(value, "type_name") != "" || stringField(value, "role") != "" || stringField(value, "conversation_id") != "" {
			return []map[string]any{value}
		}
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if list, ok := value[key].([]any); ok {
				if out := agySubagents(list); len(out) > 0 {
					return out
				}
			}
		}
	}
	return nil
}

func (c *coderStreamCollector) consumeAgyResult(result map[string]any) {
	c.agy.resultSeen = true
	c.agy.turns = 0
	if turns, ok := result["num_turns"].(float64); ok && turns > 0 {
		c.agy.turns = int(turns)
	}
	if usage, ok := mapField(result, "usage"); ok {
		c.agy.total, c.agy.hasTotal = coderusage.AgyUsage(usage), true
	}
	if text, _ := result["response"].(string); strings.TrimSpace(text) != "" {
		c.final = text
	}
	status := stringField(result, "status")
	switch {
	case status != "SUCCESS":
		c.agy.resultErr = "the run ended with status " + firstNonEmptyString(status, "(none)")
		if reason := stringField(result, "error"); reason != "" {
			c.agy.resultErr += ": " + reason
		}
	default:
		// agy calls a run whose actions were denied a success, often with an empty answer.
		if denied := agyDeniedActions(result["denied_actions"]); len(denied) > 0 {
			c.agy.resultErr = "the run was denied actions it needed and did not finish its task: " + strings.Join(denied, ", ")
		}
	}
	if c.agy.resultErr != "" {
		c.emitActivity("[agy] failed", c.agy.resultErr)
	}
}

// agyDeniedActions names a result's denied actions: "Bash (command)".
func agyDeniedActions(raw any) []string {
	list, _ := raw.([]any)
	var out []string
	for _, item := range list {
		action, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, kind := stringField(action, "display_name"), stringField(action, "action")
		switch {
		case name != "" && kind != "":
			out = append(out, name+" ("+kind+")")
		case name != "" || kind != "":
			out = append(out, name+kind)
		default:
			out = append(out, "an unnamed action")
		}
	}
	return out
}

func (c *coderStreamCollector) agyMalformedLine(line []byte) {
	if c.agy.malformed != "" {
		return
	}
	runes := []rune(string(line))
	if len(runes) > 200 {
		runes = append(runes[:200], '…')
	}
	c.agy.malformed = string(runes)
	c.emitActivity("[agy] output line is not JSON", c.agy.malformed)
}

// agyError is why an agy run failed, "" when it did not: its result's failure, else a line of
// its stream that was not JSON.
func (c *coderStreamCollector) agyError() string {
	if c.agy.resultErr != "" {
		return c.agy.resultErr
	}
	if c.agy.malformed != "" {
		return "its output had a line that is not JSON: " + c.agy.malformed
	}
	return ""
}

// agyRun is what the run used: the result's usage, which is a one-shot run's total, with its turns;
// without a result (the run was stopped), what its finished steps said.
func (c *coderStreamCollector) agyRun() coderusage.Run {
	used := c.agy.steps
	if c.agy.resultSeen && c.agy.hasTotal {
		used = c.agy.total
	}
	if used.Model == "" {
		return coderusage.Run{Turns: c.agy.turns}
	}
	return coderusage.Run{Models: []coderusage.ModelUsage{used}, Turns: c.agy.turns}
}

// agyToolStep names an agy tool by what it does. Unknown tools keep their name.
func agyToolStep(name string) string {
	switch name {
	case "run_command", "command_status", "send_command_input":
		return coderStepCommand
	case "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit":
		return coderStepEdit
	case "view_file", "list_dir", "find_by_name", "grep_search":
		return coderStepRead
	case "search_web", "read_url_content":
		return coderStepWeb
	case "call_mcp_tool":
		return coderStepTool
	case "manage_task":
		return coderStepPlan
	case "invoke_subagent", "define_subagent", "manage_subagents", "browser_subagent":
		return coderStepSubagent
	}
	if strings.Contains(name, "browser") {
		return coderStepWeb
	}
	return "using " + name
}

// agyToolDetail is what a tool step runs: a command as "$ …", else its parameters as JSON.
func agyToolDetail(info map[string]any) string {
	params, ok := mapField(info, "parameters")
	if !ok || len(params) == 0 {
		return ""
	}
	if command := stringField(params, "CommandLine"); command != "" {
		return "$ " + command
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return ""
	}
	return string(encoded)
}
