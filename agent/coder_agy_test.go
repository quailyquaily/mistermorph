package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// The streams in testdata/agy are agy 1.5.9's (2026-11-15): tool_run.jsonl and usage.json as a
// signed-in CLI wrote them (the folder renamed, the tool list shortened); the others are built from
// the events it wrote for a denied command and a missing sign-in.

// writeFakeAgy puts a stand-in agy in dir. A run replays testdata/agy/<stream> and exits with
// exitCode, after saving its arguments and the task from stdin; `-p /usage` answers usage.json,
// or fails when usage is false.
func writeFakeAgy(t *testing.T, dir, stream string, exitCode int, usage bool) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	data, err := filepath.Abs(filepath.Join("testdata", "agy"))
	if err != nil {
		t.Fatal(err)
	}
	usageAnswer := "echo 'usage unavailable' >&2\n  exit 1"
	if usage {
		usageAnswer = "cat '" + filepath.Join(data, "usage.json") + "'\n  exit 0"
	}
	body := "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"/usage\" ]; then\n  echo x >> '" + filepath.Join(dir, "usage-reads") + "'\n  " + usageAnswer + "\nfi\n" +
		"printf '%s\\n' \"$@\" > '" + filepath.Join(dir, "args") + "'\n" +
		"cat > '" + filepath.Join(dir, "task") + "'\n" +
		"cat '" + filepath.Join(data, stream) + "'\n" +
		"exit " + string(rune('0'+exitCode)) + "\n"
	writeFakeCoderExecutable(t, dir, "agy", body)
}

type agyToolRun struct {
	result   SubtaskResult
	progress []string
	texts    []string
	usageDB  string
}

// runAgyTool runs the coder tool with coder=agy against the stand-in agy in binDir.
func runAgyTool(t *testing.T, binDir string, deps coderToolDeps) agyToolRun {
	t.Helper()
	out := agyToolRun{usageDB: filepath.Join(t.TempDir(), "usage.db")}
	recorder := coderusage.NewRecorder(out.usageDB, nil)
	deps.Runner = &execDirectSubtaskRunner{}
	deps.RunCLI = runCoderCLI
	deps.PathExtra = []string{binDir}
	deps.Usage = func() *coderusage.Recorder { return recorder }
	deps.ReadAgyQuota = readAgyQuota
	tool := newCoderTool(deps)
	ctx := WithEventSinkContext(llmstats.WithRunID(context.Background(), "run-agy"), EventSinkFunc(func(_ context.Context, event Event) {
		if event.Summary != "" {
			out.progress = append(out.progress, event.Summary)
		}
		out.texts = append(out.texts, event.Text)
	}))
	raw, err := tool.Execute(ctx, map[string]any{"coder": "agy", "task": "-- read note.txt\nand say what it holds", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &out.result); err != nil {
		t.Fatal(err)
	}
	return out
}

func agyUsageRecords(t *testing.T, path string) ([]llmstats.RequestRecord, []coderusage.Quota) {
	t.Helper()
	ctx := context.Background()
	store, err := llmstats.OpenUsageStore(ctx, path, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.Records(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	quotas, err := coderusage.LoadQuotas(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	return records, quotas
}

// A real run with a tool step: the answer is the result's, the progress has the tool's line, the
// usage is the result's total (not the steps' and the total together), and the quota is read after.
func TestCoderToolRunsAgy(t *testing.T) {
	binDir := t.TempDir()
	writeFakeAgy(t, binDir, "tool_run.jsonl", 0, true)
	run := runAgyTool(t, binDir, coderToolDeps{})

	if run.result.Status != SubtaskStatusDone || !strings.HasPrefix(run.result.Output.(string), "The command `cat note.txt` printed:\n\n```\nhello from note\n```") {
		t.Fatalf("result = %+v", run.result)
	}
	// One-shot and headless, every action approved; the task on stdin, whatever it starts with.
	args, _ := os.ReadFile(filepath.Join(binDir, "args"))
	if got := strings.Fields(string(args)); !reflect.DeepEqual(got, []string{"--output-format", "stream-json", "--dangerously-skip-permissions"}) {
		t.Fatalf("args = %q", got)
	}
	if task, _ := os.ReadFile(filepath.Join(binDir, "task")); string(task) != "-- read note.txt\nand say what it holds" {
		t.Fatalf("task = %q", task)
	}

	progress := strings.Join(run.progress, "")
	for _, want := range []string{
		"[agy] started (permission mode always-proceed)",
		"[agy] run_command (step 2)",
		"[agy] run_command completed (step 2)",
	} {
		if !strings.Contains(progress, want) {
			t.Fatalf("progress lacks %q: %q", want, run.progress)
		}
	}
	texts := strings.Join(run.texts, "")
	for _, want := range []string{"$ cat note.txt", "Command output:\nhello from note", "The command `cat note.txt` printed:"} {
		if !strings.Contains(texts, want) {
			t.Fatalf("activity text lacks %q: %q", want, texts)
		}
	}

	// 11006 input + 6612 cached reads (agy's input_tokens leaves them out), 419 out, 1 turn.
	for _, want := range []string{
		"agy run: 17.6k in (6.6k cached) · 419 out · 1 turn",
		"agy quota: Gemini Models 7d 0% used",
		"Claude and GPT models 7d 0% used",
	} {
		if !strings.Contains(run.result.Usage, want) {
			t.Fatalf("usage = %q, want %q", run.result.Usage, want)
		}
	}
	if last := run.progress[len(run.progress)-1]; !strings.HasPrefix(last, "[agy] usage: agy run:") {
		t.Fatalf("last progress = %q", last)
	}

	records, quotas := agyUsageRecords(t, run.usageDB)
	if len(records) != 1 {
		t.Fatalf("records = %+v", records)
	}
	rec := records[0]
	if rec.APIHost != "antigravity-cli" || rec.Provider != "antigravity-cli" || rec.Model != "agy" || rec.Operation != "coder" || rec.Scene != "coder" ||
		rec.RunID != "run-agy" || rec.InputTokens != 17618 || rec.CachedInputTokens != 6612 || rec.OutputTokens != 419 || rec.TotalTokens != 18037 || rec.TotalCost != 0 {
		t.Fatalf("record = %+v", rec)
	}
	if len(quotas) != 1 || quotas[0].Backend != "agy" || len(quotas[0].Windows) != 2 || len(quotas[0].Groups) != 2 || quotas[0].Windows[0].Group != "Gemini Models" {
		t.Fatalf("quotas = %+v", quotas)
	}
}

func TestCoderToolAgyFailures(t *testing.T) {
	cases := []struct {
		name, stream string
		exitCode     int
		wantErr      []string
		wantRecords  int
	}{
		// agy exits 0 and says SUCCESS with an empty answer: it is a failed run all the same.
		{name: "denied action", stream: "denied.jsonl", wantErr: []string{"agy failed: the run was denied actions it needed", "Bash (command)"}, wantRecords: 1},
		{name: "error result", stream: "error.jsonl", exitCode: 1, wantErr: []string{"the run ended with status ERROR: model quota exhausted for this group", "agy exited with code 1"}},
		{name: "canceled", stream: "canceled.jsonl", wantErr: []string{"the run ended with status CANCELED"}, wantRecords: 1},
		{name: "line that is not JSON", stream: "not_json.jsonl", wantErr: []string{"its output had a line that is not JSON: jetski: panic: unexpected state"}, wantRecords: 1},
		{name: "no result", stream: "no_result.jsonl", wantErr: []string{"agy ended without a result event"}, wantRecords: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			binDir := t.TempDir()
			writeFakeAgy(t, binDir, tc.stream, tc.exitCode, false)
			run := runAgyTool(t, binDir, coderToolDeps{})
			if run.result.Status != SubtaskStatusFailed {
				t.Fatalf("result = %+v", run.result)
			}
			for _, want := range tc.wantErr {
				if !strings.Contains(run.result.Error, want) {
					t.Fatalf("error = %q, want %q", run.result.Error, want)
				}
			}
			// The quota read failed: no quota is made up, and the run's error stands.
			if strings.Contains(run.result.Usage, "quota") {
				t.Fatalf("usage = %q", run.result.Usage)
			}
			records, quotas := agyUsageRecords(t, run.usageDB)
			if len(records) != tc.wantRecords || len(quotas) != 0 {
				t.Fatalf("records = %+v, quotas = %+v", records, quotas)
			}
			// What was used before the failure is still recorded.
			if tc.wantRecords == 1 && (records[0].InputTokens != 8740 || records[0].OutputTokens != 84 || records[0].APIHost != "antigravity-cli") {
				t.Fatalf("record = %+v", records[0])
			}
		})
	}
}

// Not signed in, agy prints a sign-in link and waits a minute. The run stops at the prompt, says
// what to do, keeps the link out of the result and the activity, and reads no quota.
func TestCoderToolAgyNotSignedIn(t *testing.T) {
	binDir := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	writeFakeCoderExecutable(t, binDir, "agy", "if [ \"$1\" = \"-p\" ]; then echo x >> '"+filepath.Join(binDir, "usage-reads")+"'; exit 1; fi\n"+
		"cat >/dev/null\n"+
		"printf '%s\\n' 'Authentication required. Please visit the URL to log in:' '  https://accounts.example.test/o/oauth2/auth?client_id=fake' '' 'Waiting for authentication (timeout 60s)...' >&2\n"+
		"sleep 30\n")
	started := time.Now()
	run := runAgyTool(t, binDir, coderToolDeps{})
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("waited %s at the sign-in prompt", elapsed)
	}
	if run.result.Status != SubtaskStatusFailed || !strings.Contains(run.result.Error, "agy is not signed in: run `agy` once in a terminal and sign in") {
		t.Fatalf("result = %+v", run.result)
	}
	all := run.result.Error + strings.Join(run.texts, "") + strings.Join(run.progress, "")
	if strings.Contains(all, "accounts.example.test") {
		t.Fatalf("the sign-in link leaked: %q", all)
	}
	if _, err := os.Stat(filepath.Join(binDir, "usage-reads")); err == nil {
		t.Fatal("read the quota of a CLI that is not signed in")
	}

	// The CLI's own answer after its wait is the same failure.
	binDir = t.TempDir()
	writeFakeAgy(t, binDir, "not_signed_in.jsonl", 1, false)
	run = runAgyTool(t, binDir, coderToolDeps{})
	if run.result.Status != SubtaskStatusFailed || !strings.Contains(run.result.Error, "agy is not signed in") {
		t.Fatalf("result = %+v", run.result)
	}
	if _, err := os.Stat(filepath.Join(binDir, "usage-reads")); err == nil {
		t.Fatal("read the quota of a CLI that is not signed in")
	}
}

func TestCoderToolAgyMissingExecutable(t *testing.T) {
	// Nothing on PATH: an agy installed on this machine is not the one under test.
	t.Setenv("PATH", t.TempDir())
	run := runAgyTool(t, t.TempDir(), coderToolDeps{})
	if run.result.Status != SubtaskStatusFailed || !strings.Contains(run.result.Error, "agy executable not found in PATH") {
		t.Fatalf("result = %+v", run.result)
	}
}

// In the Console, Codex and Claude Code keep their terminal sessions; agy runs one-shot.
func TestCoderToolAgyRunsOneShotBesideTerminalSessions(t *testing.T) {
	binDir := t.TempDir()
	writeFakeAgy(t, binDir, "tool_run.jsonl", 0, true)
	writeFakeCoderExecutable(t, binDir, "codex", "exit 0\n")
	var terminal []string
	deps := coderToolDeps{RunTerminal: func(_ context.Context, req CoderRequest) (string, error) {
		terminal = append(terminal, req.Backend)
		return "from the terminal", nil
	}}
	run := runAgyTool(t, binDir, deps)
	if run.result.Status != SubtaskStatusDone || len(terminal) != 0 || !strings.Contains(run.result.Output.(string), "hello from note") {
		t.Fatalf("result = %+v, terminal = %q", run.result, terminal)
	}

	deps.Runner, deps.PathExtra = &execDirectSubtaskRunner{}, []string{binDir}
	tool := newCoderTool(deps)
	if _, err := tool.Execute(context.Background(), map[string]any{"coder": "codex", "task": "t", "cwd": t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(terminal, []string{"codex"}) {
		t.Fatalf("terminal = %q", terminal)
	}
	for _, want := range []string{"Antigravity CLI (agy)", "agy has no session", "runs every action without asking the user"} {
		if desc := tool.Description(); !strings.Contains(desc, want) {
			t.Fatalf("description = %q, want %q", desc, want)
		}
	}
	oneShot := newCoderTool(coderToolDeps{})
	if !strings.Contains(oneShot.Description(), "Antigravity (agy) CLI") || !strings.Contains(oneShot.ParameterSchema(), `"agy"`) {
		t.Fatalf("description = %q, schema = %s", oneShot.Description(), oneShot.ParameterSchema())
	}
}

func TestCoderBuildAgyCLICommand(t *testing.T) {
	agy := buildCoderCLICommand(CoderRequest{Backend: coderBackendAgy, Task: "review", CWD: "/repo"})
	if agy.Command != "agy" || agy.Stdin != "review" || agy.Dir != "/repo" {
		t.Fatalf("agy = %+v", agy)
	}
	if want := []string{"--output-format", "stream-json", "--dangerously-skip-permissions"}; !reflect.DeepEqual(agy.Args, want) {
		t.Fatalf("agy.Args = %#v, want %#v", agy.Args, want)
	}
}

// Steps the captured streams lack, as the docs describe them: a failed tool, a sub-agent, a
// checkpoint, text over two steps, and the steps' usage when no result comes.
func TestCoderStreamCollectorAgySteps(t *testing.T) {
	var steps, texts []string
	var answer strings.Builder
	collector := newCoderStreamCollector(coderBackendAgy, func(text string) { answer.WriteString(text) })
	collector.progress = func(summary, text, step string) {
		steps = append(steps, strings.TrimSpace(summary)+" | "+step)
		texts = append(texts, text)
	}
	lines := []string{
		`{"event":"init","conversation_id":"c","init":{"cwd":"/work","tools":[],"permission_mode":"always-proceed","model":"gemini-3.8-flash-high"}}`,
		`{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}`,
		`{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Looking "}}`,
		`{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"now.","usage":{"input_tokens":100,"output_tokens":10,"thinking_tokens":4,"cache_read_tokens":50,"total_tokens":110}}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/work/a.go"}}}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/work/a.go"}}}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/work/a.go"},"error":{"type":"NOT_FOUND","message":"no such file"}}}}`,
		`{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"invoke_subagent","tool_info":{"name":"invoke_subagent","parameters":{"Prompt":"look"}},"subagent_info":{"subagents":[{"type_name":"researcher","role":"explore","conversation_id":"sub-1"}]}}}`,
		`{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"invoke_subagent","tool_info":{"name":"invoke_subagent","output":"found"},"subagent_info":{"subagents":[{"type_name":"researcher","role":"explore","conversation_id":"sub-1"}]}}}`,
		`{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"checkpoint"}}`,
		`{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"Done.\n","usage":{"input_tokens":20,"output_tokens":5,"thinking_tokens":1,"cache_read_tokens":150,"total_tokens":25}}}`,
	}
	for _, line := range lines {
		if err := collector.ConsumeLine([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"[agy] started (permission mode always-proceed) | starting up",
		"[agy] thinking | thinking",
		"[agy] view_file (step 2) | reading code",
		"[agy] view_file failed (step 2) | thinking",
		"[agy] subagent researcher (explore) | running a subagent",
		"[agy] invoke_subagent (step 3) | running a subagent",
		"[agy] invoke_subagent completed (step 3) | thinking",
		"[agy] checkpoint (step 4) | thinking",
	}
	if !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %q\nwant    %q", steps, want)
	}
	if all := strings.Join(texts, ""); !strings.Contains(all, `{"AbsolutePath":"/work/a.go"}`) || !strings.Contains(all, "NOT_FOUND: no such file") {
		t.Fatalf("texts = %q", all)
	}
	// Text of two steps is kept apart by a line end.
	if got := answer.String(); got != "Looking now.\nDone.\n" || collector.Output() != "Looking now.\nDone." {
		t.Fatalf("answer = %q, output = %q", got, collector.Output())
	}
	// Without a result, the usage is the finished steps': 120 input and 200 cached reads.
	run := collector.Run()
	if len(run.Models) != 1 || run.Models[0].InputTokens != 320 || run.Models[0].CachedInputTokens != 200 || run.Models[0].OutputTokens != 15 || run.Models[0].ReasoningTokens != 5 || run.Turns != 0 {
		t.Fatalf("run = %+v", run)
	}

	// The result's usage is the run's total: it replaces the steps' sum.
	_ = collector.ConsumeLine([]byte(`{"event":"result","result":{"status":"SUCCESS","response":"Looking now.\nDone.\n","num_turns":2,"usage":{"input_tokens":120,"output_tokens":15,"thinking_tokens":5,"cache_read_tokens":200,"total_tokens":135}}}`))
	run = collector.Run()
	if len(run.Models) != 1 || run.Models[0].InputTokens != 320 || run.Models[0].OutputTokens != 15 || run.Turns != 2 || collector.Error() != "" {
		t.Fatalf("run = %+v, error = %q", run, collector.Error())
	}
}

// Opt in to run the installed, signed-in agy once through the coder tool: a harmless task in a
// throwaway folder, then its quota read.
func TestInstalledAgyRun(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_AGY") != "1" {
		t.Skip("set MISTERMORPH_TEST_AGY=1 to run the installed CLI")
	}
	work := t.TempDir()
	if err := os.WriteFile(filepath.Join(work, "note.txt"), []byte("hello from note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	usageDB := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usageDB, nil)
	tool := newCoderTool(coderToolDeps{
		Runner:       &execDirectSubtaskRunner{},
		RunCLI:       runCoderCLI,
		Usage:        func() *coderusage.Recorder { return recorder },
		ReadAgyQuota: readAgyQuota,
	})
	var progress []string
	ctx := WithEventSinkContext(context.Background(), EventSinkFunc(func(_ context.Context, event Event) {
		if event.Summary != "" {
			progress = append(progress, strings.TrimSpace(event.Summary))
		}
	}))
	raw, err := tool.Execute(ctx, map[string]any{"coder": "agy", "task": "Run the shell command 'cat note.txt' and tell me what it printed. Do not change any files.", "cwd": work})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	t.Logf("status: %s\nusage: %s\nprogress:\n  %s", result.Status, result.Usage, strings.Join(progress, "\n  "))
	if result.Status != SubtaskStatusDone || !strings.Contains(result.Output.(string), "hello from note") {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Usage, "agy run: ") || !strings.Contains(result.Usage, "agy quota: ") {
		t.Fatalf("usage = %q", result.Usage)
	}
	records, quotas := agyUsageRecords(t, usageDB)
	if len(records) != 1 || records[0].APIHost != "antigravity-cli" || records[0].InputTokens == 0 || len(quotas) != 1 || len(quotas[0].Groups) == 0 {
		t.Fatalf("records = %+v, quotas = %+v", records, quotas)
	}
}
