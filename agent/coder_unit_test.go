package agent

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// unitRecorder collects what a coder reports as units and what it sends live.
type unitRecorder struct {
	mu     sync.Mutex
	units  []string
	labels []string
	live   strings.Builder
}

func (r *unitRecorder) unit(label, text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.labels = append(r.labels, label)
	r.units = append(r.units, text)
}

func (r *unitRecorder) collector(backend string) *coderStreamCollector {
	c := newCoderStreamCollector(backend, func(text string) { r.live.WriteString(text) })
	c.progress = func(_, text, _ string) { r.live.WriteString(text) }
	c.unit = r.unit
	return c
}

func consumeLines(t *testing.T, c *coderStreamCollector, events ...map[string]any) {
	t.Helper()
	for _, event := range events {
		line, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.ConsumeLine(line); err != nil {
			t.Fatal(err)
		}
	}
}

// A command's output is a unit only once the command has completed: what it has printed so far
// may end in the middle of a secret.
func TestCoderUnitsCodexCommandOutputIsReportedWhole(t *testing.T) {
	var rec unitRecorder
	c := rec.collector(coderBackendCodex)
	item := func(typ, status, output string) map[string]any {
		return map[string]any{"type": typ, "item": map[string]any{
			"id": "item_1", "type": "command_execution", "command": "  cat .env ", "status": status, "aggregated_output": output,
		}}
	}
	whole := "\nAPI_KEY=abcdefgh" + "ijklmnopqrstuvwx\nDONE  \n"
	consumeLines(t, c,
		item("item.started", "in_progress", ""),
		item("item.updated", "in_progress", "\nAPI_KEY=abcdefgh"),
		item("item.updated", "in_progress", "\nAPI_KEY=abcdefghijklmnop"),
	)
	if want := []string{"$   cat .env "}; !reflect.DeepEqual(rec.units, want) {
		t.Fatalf("units while the command runs = %q, want %q", rec.units, want)
	}
	consumeLines(t, c, item("item.completed", "completed", whole))
	// The command line once, and the output exactly as printed, edges included.
	if want := []string{"$   cat .env ", whole}; !reflect.DeepEqual(rec.units, want) {
		t.Fatalf("units = %q, want %q", rec.units, want)
	}
	// The live path is as before: it has the pieces as they came.
	if live := rec.live.String(); !strings.Contains(live, "API_KEY=abcdefgh\n") || !strings.Contains(live, "ijklmnop") {
		t.Fatalf("live text = %q", live)
	}

	// A command seen only when it completes still gets its line first; a command without
	// output gets no output unit.
	rec.units = nil
	consumeLines(t, c, map[string]any{"type": "item.completed", "item": map[string]any{
		"id": "item_2", "type": "command_execution", "command": "true", "status": "completed", "aggregated_output": " \n",
	}})
	if want := []string{"$ true"}; !reflect.DeepEqual(rec.units, want) {
		t.Fatalf("units = %q, want %q", rec.units, want)
	}
}

func TestCoderUnitsCodexMessagesAndErrors(t *testing.T) {
	var rec unitRecorder
	c := rec.collector(coderBackendCodex)
	consumeLines(t, c,
		// A message still being written is not a unit.
		map[string]any{"type": "item.updated", "item": map[string]any{"id": "m1", "type": "agent_message", "text": "The token is Bearer "}},
		map[string]any{"type": "item.completed", "item": map[string]any{"id": "m1", "type": "agent_message", "text": " The token is Bearer abcdefghijklmnopqrstuvwx \n"}},
		map[string]any{"type": "error", "message": "stream error: api_key=abcdefghijklmnop"},
		map[string]any{"type": "turn.failed", "error": map[string]any{"message": "boom"}},
	)
	want := []string{" The token is Bearer abcdefghijklmnopqrstuvwx \n", "stream error: api_key=abcdefghijklmnop", "boom"}
	if !reflect.DeepEqual(rec.units, want) {
		t.Fatalf("units = %q, want %q", rec.units, want)
	}
	// The final answer was the last message, so it is not reported again.
	c.reportFinal()
	if len(rec.units) != len(want) {
		t.Fatalf("final reported twice: %q", rec.units)
	}
}

func TestCoderUnitsClaude(t *testing.T) {
	var rec unitRecorder
	c := rec.collector(coderBackendClaude)
	delta := func(text string) map[string]any {
		return map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "delta": map[string]any{"type": "text_delta", "text": text}}}
	}
	consumeLines(t, c, delta("Bearer "), delta("abcdefghij"), delta("klmnopqrstuvwx"))
	if len(rec.units) != 0 {
		t.Fatalf("pieces of a message were reported as units: %q", rec.units)
	}
	consumeLines(t, c,
		// Two text parts: the space that ends the first is what makes the token a bearer token.
		map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": "Bearer "},
			map[string]any{"type": "text", "text": "abcdefghijklmnopqrstuvwx"},
		}}},
		// A tool input whose string has a line break and a quote.
		map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{
				"command":     "export API_KEY=\nabcdefghijklmnopqrstuvwx && echo \"ok\"",
				"description": "set the key",
				"timeout":     float64(5000),
				"env":         map[string]any{"A": "1"},
				"args":        []any{"x", "y"},
			}},
		}}},
		map[string]any{"type": "user", "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": []any{
				map[string]any{"type": "text", "text": " password=\n"},
				map[string]any{"type": "text", "text": "abcdefghijklmnop "},
			}},
		}}},
	)
	want := []string{
		"Bearer abcdefghijklmnopqrstuvwx",
		"args: - x\n- y\ncommand: export API_KEY=\nabcdefghijklmnopqrstuvwx && echo \"ok\"\ndescription: set the key\nenv: A: 1\ntimeout: 5000",
		" password=\nabcdefghijklmnop ",
	}
	if !reflect.DeepEqual(rec.units, want) {
		t.Fatalf("units = %q,\nwant %q", rec.units, want)
	}
	// The result event repeats the last message; a different final answer is reported.
	consumeLines(t, c, map[string]any{"type": "result", "result": "Bearer abcdefghijklmnopqrstuvwx"})
	c.reportFinal()
	if len(rec.units) != len(want) {
		t.Fatalf("final reported twice: %q", rec.units)
	}
	consumeLines(t, c, map[string]any{"type": "result", "result": "A different final answer."})
	c.reportFinal()
	if got := rec.units[len(rec.units)-1]; got != "A different final answer." {
		t.Fatalf("final = %q", got)
	}
}

// Lines that are not events are one text: they are reported whole, at the end, or not at all.
func TestCoderUnitsPlainOutputIsHeldToTheEnd(t *testing.T) {
	var rec unitRecorder
	c := rec.collector(coderBackendCodex)
	for _, line := range []string{"-----BEGIN RSA PRIVATE KEY-----", "SENSITIVEPAYLOAD123456", "-----END RSA PRIVATE KEY-----"} {
		if err := c.ConsumeLine([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if len(rec.units) != 0 {
		t.Fatalf("plain lines were reported one by one: %q", rec.units)
	}
	c.plain.report(rec.unit, "[codex] output")
	want := "-----BEGIN RSA PRIVATE KEY-----\nSENSITIVEPAYLOAD123456\n-----END RSA PRIVATE KEY-----\n"
	if !reflect.DeepEqual(rec.units, []string{want}) || rec.labels[0] != "[codex] output" {
		t.Fatalf("units = %q, labels = %q", rec.units, rec.labels)
	}
	// Reported once: nothing is left.
	c.plain.report(rec.unit, "[codex] output")
	if len(rec.units) != 1 {
		t.Fatalf("reported again: %q", rec.units)
	}

	// Too large, or with a line lost, none of it is reported, only that it was left out.
	for name, spoil := range map[string]func(*coderWholeOutput){
		"too large": func(o *coderWholeOutput) { o.add(strings.Repeat("x", coderWholeOutputMaxBytes)) },
		"line lost": func(o *coderWholeOutput) { o.drop() },
	} {
		var rec unitRecorder
		var held coderWholeOutput
		held.add("-----BEGIN RSA PRIVATE KEY-----\n")
		spoil(&held)
		held.add("SENSITIVEPAYLOAD123456\n")
		held.report(rec.unit, "[codex] stderr")
		if len(rec.units) != 1 || rec.units[0] != "" || !strings.Contains(rec.labels[0], "[codex] stderr not shown") {
			t.Fatalf("%s: units = %q, labels = %q", name, rec.units, rec.labels)
		}
	}
	// Nothing held, nothing reported.
	var empty coderWholeOutput
	empty.add(" \n")
	empty.report(rec.unit, "[codex] stderr")
	if len(rec.units) != 1 {
		t.Fatalf("blank output reported: %q", rec.units)
	}
}

// The whole of what the CLI wrote to stderr is one unit, reported when the CLI has ended,
// while each line still goes out live as before.
func TestRunCoderCLIReportsStderrAndPlainOutputWholeAtTheEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "codex", strings.Join([]string{
		`printf '%s\n' 'api_key=' >&2`,
		`printf '%s\n' 'abcdefghijklmnopqrstuvwx' >&2`,
		`printf '%s\n' 'plain line one'`,
		`printf '%s\n' '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"All done."}}'`,
		`printf '%s\n' 'plain line two'`,
		`printf '%s' 'last stderr line without a line break' >&2`,
	}, "\n")+"\n")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var rec unitRecorder
	var live []string
	var unitsAtLastProgress int
	output, err := runCoderCLI(context.Background(), CoderRequest{
		Backend: coderBackendCodex, Task: "x", CWD: t.TempDir(),
		Progress: func(_, text, _ string) {
			live = append(live, text)
			rec.mu.Lock()
			unitsAtLastProgress = len(rec.units)
			rec.mu.Unlock()
		},
		Unit: rec.unit,
	}, func(string) {})
	if err != nil || output != "All done." {
		t.Fatalf("runCoderCLI() = %q, %v", output, err)
	}
	units := map[string]string{}
	for i, label := range rec.labels {
		units[label] = rec.units[i]
	}
	if got, want := units["[codex] stderr"], "api_key=\nabcdefghijklmnopqrstuvwx\nlast stderr line without a line break\n"; got != want {
		t.Fatalf("stderr unit = %q, want %q", got, want)
	}
	if got, want := units["[codex] output"], "plain line one\nplain line two\n"; got != want {
		t.Fatalf("plain output unit = %q, want %q", got, want)
	}
	if got := units[""]; got != "All done." {
		t.Fatalf("message unit = %q", got)
	}
	if len(rec.units) != 3 {
		t.Fatalf("units = %q (labels %q)", rec.units, rec.labels)
	}
	// Live, each stderr line is still sent as it comes, as before.
	joined := strings.Join(live, "")
	if !strings.Contains(joined, "[codex stderr] api_key=\n") || !strings.Contains(joined, "[codex stderr] abcdefghijklmnopqrstuvwx\n") {
		t.Fatalf("live text = %q", joined)
	}
	// The held units come before the last status line, which says the process ended.
	if unitsAtLastProgress != 3 || !strings.Contains(live[len(live)-1], "process ended") {
		t.Fatalf("units at the last status line = %d, last = %q", unitsAtLastProgress, live[len(live)-1])
	}
}

// Without a Unit callback nothing changes, and nothing is held for long.
func TestCoderWithoutUnitCallback(t *testing.T) {
	c := newCoderStreamCollector(coderBackendCodex, nil)
	consumeLines(t, c, map[string]any{"type": "item.completed", "item": map[string]any{
		"id": "item_1", "type": "command_execution", "command": "ls", "status": "completed", "aggregated_output": "a\n",
	}})
	c.emitUnit("x")
	c.emitMessageUnit("x")
	c.reportFinal()
	c.plain.report(nil, "label")
	if len(c.commandShown) != 0 {
		t.Fatalf("commandShown = %v", c.commandShown)
	}
}

// The coder tool sends each unit as an event of its own kind, beside the live output events.
func TestCoderToolEmitsUnitsAsEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	bin := t.TempDir()
	writeFakeCoderExecutable(t, bin, coderBackendCodex, "exit 0\n")
	run := func(deps coderToolDeps) []Event {
		t.Helper()
		deps.Runner = &execDirectSubtaskRunner{}
		var events []Event
		ctx := WithEventSinkContext(context.Background(), EventSinkFunc(func(_ context.Context, event Event) {
			events = append(events, event)
		}))
		if _, err := newCoderTool(deps).Execute(ctx, map[string]any{"coder": "codex", "task": "t", "cwd": t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		return events
	}

	events := run(coderToolDeps{RunCLI: func(_ context.Context, req CoderRequest, emit func(string)) (string, error) {
		emit("token=abcdefgh")
		emit("ijklmnopqrstuvwx\n")
		req.Unit("[codex] stderr", "token=abcdefghijklmnopqrstuvwx\n")
		return "done", nil
	}})
	if len(events) != 3 || events[0].Kind != EventKindToolOutput || events[1].Kind != EventKindToolOutput {
		t.Fatalf("events = %#v", events)
	}
	unit := events[2]
	if unit.Kind != EventKindToolOutputUnit || unit.ToolName != coderToolName || unit.Stream != "codex" ||
		unit.Summary != "[codex] stderr" || unit.Text != "token=abcdefghijklmnopqrstuvwx\n" {
		t.Fatalf("unit event = %#v", unit)
	}

	// A terminal session returns its output whole: it goes out live and as one unit.
	events = run(coderToolDeps{PathExtra: []string{bin}, RunTerminal: func(context.Context, CoderRequest) (string, error) {
		return "terminal output\n", nil
	}})
	if len(events) != 2 || events[0].Kind != EventKindToolOutput || events[1].Kind != EventKindToolOutputUnit ||
		events[0].Text != "terminal output\n" || events[1].Text != "terminal output\n" || events[1].Summary != "" {
		t.Fatalf("terminal events = %#v", events)
	}
}
