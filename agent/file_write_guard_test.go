package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// rootWriteTool is write_file for the guard tests: it writes relative paths under root.
type rootWriteTool struct {
	root  string
	paths []string
}

func (t *rootWriteTool) Name() string            { return "write_file" }
func (t *rootWriteTool) Description() string     { return "writes a file" }
func (t *rootWriteTool) ParameterSchema() string { return "{}" }
func (t *rootWriteTool) Execute(_ context.Context, params map[string]any) (string, error) {
	path, _ := params["path"].(string)
	t.paths = append(t.paths, path)
	full := filepath.Join(t.root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, []byte("content"), 0o644); err != nil {
		return "", err
	}
	return "written " + path, nil
}

func writeCall(path string) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{
		ID:        "write-" + path,
		Name:      "write_file",
		Arguments: map[string]any{"path": path, "content": "content"},
	}}}
}

// manyFinals pads a script, so that a guard that kept asking would keep getting answers.
func manyFinals(script ...llm.Result) []llm.Result {
	for i := 0; i < 40; i++ {
		script = append(script, finalResponse(fmt.Sprintf("done %d", i)))
	}
	return script
}

func writeGuardEngine(t *testing.T, withWriter bool, script ...llm.Result) (*Engine, *mockClient, *rootWriteTool, string) {
	t.Helper()
	root := t.TempDir()
	// The process directory holds none of the requested files.
	t.Chdir(t.TempDir())
	registry := tools.NewRegistry()
	writer := &rootWriteTool{root: root}
	if withWriter {
		registry.Register(writer)
	}
	client := newMockClient(script...)
	engine := New(client, registry, Config{MaxSteps: 60}, DefaultPromptSpec(),
		WithEngineToolsConfig(EngineToolsConfig{PathRoots: pathroots.New(root, "", "")}))
	return engine, client, writer, root
}

func unsatisfied(t *testing.T, err error) *FileWriteUnsatisfiedError {
	t.Helper()
	var unsat *FileWriteUnsatisfiedError
	if !errors.As(err, &unsat) || !errors.Is(err, ErrFileWriteUnsatisfied) {
		t.Fatalf("error = %v, want a FileWriteUnsatisfiedError", err)
	}
	return unsat
}

func missingPaths(unsat *FileWriteUnsatisfiedError) []string {
	out := make([]string, 0, len(unsat.Missing))
	for _, m := range unsat.Missing {
		out = append(out, m.Path)
	}
	return out
}

func reminderCount(calls []llm.Request) int {
	if len(calls) == 0 {
		return 0
	}
	count := 0
	for _, msg := range calls[len(calls)-1].Messages {
		if msg.Role == "user" && strings.Contains(msg.Content, "You must write the requested file(s)") {
			count++
		}
	}
	return count
}

// The reported run: "Write down to the design/ folder" was read as a file named "the de",
// so the write to design/mobile-popups.md never satisfied the guard and the run wrote the
// file 68 times.
func TestFileWriteGuardReproductionDirectoryProseCompletes(t *testing.T) {
	task := "Define the shared mobile popup presentation. Write down to the design/ folder."
	engine, client, writer, root := writeGuardEngine(t, true, manyFinals(
		writeCall("design/mobile-popups.md"),
	)...)

	final, _, err := engine.Run(context.Background(), task, RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if final == nil || final.Output != "done 0" {
		t.Fatalf("final = %#v, want the first final", final)
	}
	if calls := client.allCalls(); len(calls) != 2 || reminderCount(calls) != 0 {
		t.Fatalf("llm calls = %d, reminders = %d, want 2 and 0", len(calls), reminderCount(calls))
	}
	if !slices.Equal(writer.paths, []string{"design/mobile-popups.md"}) {
		t.Fatalf("writes = %q, want one write", writer.paths)
	}
	for _, bogus := range []string{"the de", "the", "design/the de"} {
		if _, statErr := os.Stat(filepath.Join(root, bogus)); statErr == nil {
			t.Fatalf("bogus file %q exists", bogus)
		}
	}
}

func TestFileWriteGuardFulfilledRequirementFinishesAtOnce(t *testing.T) {
	cases := []struct {
		name string
		task string
		path string
	}{
		{name: "relative under design", task: "Write it to design/mobile-popups.md", path: "design/mobile-popups.md"},
		{name: "name with s", task: "save it to results/status-summaries.md.", path: "results/status-summaries.md"},
		{name: "backticks with spaces", task: "save it to `design/mobile popups.md`", path: "design/mobile popups.md"},
		{name: "quotes with spaces", task: `output to "My Notes/final report.md"`, path: "My Notes/final report.md"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			engine, client, writer, _ := writeGuardEngine(t, true, manyFinals(writeCall(tc.path))...)
			final, _, err := engine.Run(context.Background(), tc.task, RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if final == nil || final.Output != "done 0" {
				t.Fatalf("final = %#v, want the first final", final)
			}
			if calls := client.allCalls(); len(calls) != 2 || reminderCount(calls) != 0 {
				t.Fatalf("llm calls = %d, reminders = %d, want 2 and 0", len(calls), reminderCount(calls))
			}
			if len(writer.paths) != 1 {
				t.Fatalf("writes = %q, want one", writer.paths)
			}
		})
	}
}

func TestFileWriteGuardAsksOnceForAGenuinelyMissingFile(t *testing.T) {
	engine, client, writer, root := writeGuardEngine(t, true, manyFinals(
		finalResponse("early"),
		writeCall("out/report.md"),
	)...)

	final, _, err := engine.Run(context.Background(), "Research it and save it to out/report.md", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if final == nil || final.Output != "done 0" {
		t.Fatalf("final = %#v, want the final after the write", final)
	}
	calls := client.allCalls()
	if len(calls) != 3 || reminderCount(calls) != 1 {
		t.Fatalf("llm calls = %d, reminders = %d, want 3 and 1", len(calls), reminderCount(calls))
	}
	if !requestContains(calls, 1, "before finishing: out/report.md.") || !requestContains(calls, 1, "write_file tool") {
		t.Fatalf("the reminder does not name the file and the tool")
	}
	if len(writer.paths) != 1 {
		t.Fatalf("writes = %q, want one", writer.paths)
	}
	if info, statErr := os.Stat(filepath.Join(root, "out", "report.md")); statErr != nil || info.IsDir() {
		t.Fatalf("out/report.md was not written: %v", statErr)
	}
}

func TestFileWriteGuardStopsWritesThatMakeNoProgress(t *testing.T) {
	script := []llm.Result{finalResponse("early")}
	for i := 0; i < 40; i++ {
		script = append(script, writeCall("notes/other.md"), finalResponse("done"))
	}
	engine, client, writer, _ := writeGuardEngine(t, true, script...)

	final, _, err := engine.Run(context.Background(), "Save it to report.md", RunOptions{})
	unsat := unsatisfied(t, err)
	if final != nil {
		t.Fatalf("final = %#v, want none", final)
	}
	if !slices.Equal(missingPaths(unsat), []string{"report.md"}) {
		t.Fatalf("missing = %q, want report.md", missingPaths(unsat))
	}
	if unsat.Interventions != maxFileWriteNoProgress || !strings.Contains(unsat.Reason, "no progress") {
		t.Fatalf("interventions = %d, reason = %q, want %d and no progress", unsat.Interventions, unsat.Reason, maxFileWriteNoProgress)
	}
	if !strings.Contains(err.Error(), `"report.md"`) || !strings.Contains(err.Error(), "checked") {
		t.Fatalf("error %q does not name the file and where it was checked", err.Error())
	}
	// early, write, final, write, final: the third unchanged final ends the run.
	calls := client.allCalls()
	if len(calls) != 5 || len(writer.paths) != maxFileWriteNoProgress {
		t.Fatalf("llm calls = %d, writes = %d, want 5 and %d", len(calls), len(writer.paths), maxFileWriteNoProgress)
	}
	if !requestContains(calls, 4, "This is the last reminder before the run fails.") {
		t.Fatalf("the second reminder does not say it is the last")
	}
}

func TestFileWriteGuardCapsRemindersDespitePartialProgress(t *testing.T) {
	task := "Write to a.md, then write to b.md, then write to c.md, then write to d.md."
	script := []llm.Result{finalResponse("early")}
	for _, path := range []string{"a.md", "b.md", "c.md"} {
		script = append(script, writeCall(path), finalResponse("partly done"))
	}
	engine, client, writer, _ := writeGuardEngine(t, true, manyFinals(script...)...)

	_, _, err := engine.Run(context.Background(), task, RunOptions{})
	unsat := unsatisfied(t, err)
	if !slices.Equal(missingPaths(unsat), []string{"d.md"}) {
		t.Fatalf("missing = %q, want only d.md", missingPaths(unsat))
	}
	if unsat.Interventions != maxFileWriteInterventions || !strings.Contains(unsat.Reason, "still missing after") {
		t.Fatalf("interventions = %d, reason = %q, want the cap", unsat.Interventions, unsat.Reason)
	}
	if calls := client.allCalls(); len(calls) != 7 || len(writer.paths) != 3 {
		t.Fatalf("llm calls = %d, writes = %d, want 7 and 3", len(calls), len(writer.paths))
	}
}

func TestFileWriteGuardPartialProgressCanFinish(t *testing.T) {
	engine, client, _, _ := writeGuardEngine(t, true, manyFinals(
		finalResponse("early"),
		writeCall("a.md"),
		finalResponse("half"),
		writeCall("b.md"),
	)...)

	final, _, err := engine.Run(context.Background(), "Write to a.md and write to b.md", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if final == nil || final.Output != "done 0" {
		t.Fatalf("final = %#v, want the final after both writes", final)
	}
	if calls := client.allCalls(); len(calls) != 5 || reminderCount(calls) != 2 {
		t.Fatalf("llm calls = %d, reminders = %d, want 5 and 2", len(calls), reminderCount(calls))
	}
}

func TestFileWriteGuardWithoutAWriterFailsWithDiagnostic(t *testing.T) {
	engine, client, _, _ := writeGuardEngine(t, false, manyFinals()...)

	final, _, err := engine.Run(context.Background(), "Save it to report.md", RunOptions{})
	unsat := unsatisfied(t, err)
	if final != nil {
		t.Fatalf("final = %#v, want none", final)
	}
	if unsat.Interventions != 0 || !strings.Contains(unsat.Reason, "no tool that can write files") {
		t.Fatalf("interventions = %d, reason = %q", unsat.Interventions, unsat.Reason)
	}
	if !slices.Equal(missingPaths(unsat), []string{"report.md"}) {
		t.Fatalf("missing = %q, want report.md", missingPaths(unsat))
	}
	if calls := client.allCalls(); len(calls) != 1 {
		t.Fatalf("llm calls = %d, want 1", len(calls))
	}
}

func TestFileWriteGuardMalformedIntentAsksForNothing(t *testing.T) {
	tasks := []string{
		"save it to \"design/mobile popups.md\nand stop",
		"write to `",
		"Write down to the",
		"save it to design/",
		"output to ../",
	}
	for _, task := range tasks {
		t.Run(task, func(t *testing.T) {
			engine, client, writer, _ := writeGuardEngine(t, true, manyFinals()...)
			final, _, err := engine.Run(context.Background(), task, RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if final == nil || final.Output != "done 0" {
				t.Fatalf("final = %#v, want the first final", final)
			}
			if calls := client.allCalls(); len(calls) != 1 || len(writer.paths) != 0 {
				t.Fatalf("llm calls = %d, writes = %d, want 1 and 0", len(calls), len(writer.paths))
			}
		})
	}
}

func TestFileWriteGuardKeepsItsBoundsAcrossResume(t *testing.T) {
	root := t.TempDir()
	t.Chdir(t.TempDir())
	store := newMemoryApprovalStore()
	g := approvalGuard(store, nil)
	var bashCalls int
	registry := tools.NewRegistry()
	registry.Register(&countingTool{name: "bash", result: "bash-result", count: &bashCalls})
	bashCall := llm.Result{ToolCalls: []llm.ToolCall{{ID: "bash-1", Name: "bash", Arguments: map[string]any{"cmd": "echo hi"}}}}
	client := newMockClient(manyFinals(
		finalResponse("early"),
		finalResponse("early again"),
		bashCall,
	)...)
	engine := New(client, registry, Config{MaxSteps: 60}, DefaultPromptSpec(), WithGuard(g),
		WithEngineToolsConfig(EngineToolsConfig{PathRoots: pathroots.New(root, "", "")}))

	pending, _, err := engine.Run(context.Background(), "Save it to report.md", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	approvalID := pendingApprovalID(t, pending)
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatalf("ResolveApproval() error = %v", err)
	}

	final, _, err := engine.Resume(context.Background(), approvalID)
	unsat := unsatisfied(t, err)
	if final != nil {
		t.Fatalf("final = %#v, want none", final)
	}
	if unsat.Interventions != maxFileWriteNoProgress || !strings.Contains(unsat.Reason, "no progress") {
		t.Fatalf("interventions = %d, reason = %q, want the bounds of before the pause", unsat.Interventions, unsat.Reason)
	}
	if !slices.Equal(missingPaths(unsat), []string{"report.md"}) {
		t.Fatalf("missing = %q, want report.md", missingPaths(unsat))
	}
	// Two reminders before the pause, none after it.
	if calls := client.allCalls(); len(calls) != 4 || bashCalls != 1 {
		t.Fatalf("llm calls = %d, bash calls = %d, want 4 and 1", len(calls), bashCalls)
	}
}

func TestFileWriteGuardResumedRunChecksTheTaskAgain(t *testing.T) {
	cases := []struct {
		name      string
		task      string
		writeFile string
		wantErr   bool
	}{
		{name: "fulfilled during the pause", task: "Save it to out/report.md", writeFile: "out/report.md"},
		{name: "directory prose", task: "Write down to the design/ folder."},
		{name: "still missing", task: "Save it to out/report.md", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			t.Chdir(t.TempDir())
			store := newMemoryApprovalStore()
			g := approvalGuard(store, nil)
			registry := tools.NewRegistry()
			registry.Register(&countingTool{name: "bash", result: "bash-result"})
			bashCall := llm.Result{ToolCalls: []llm.ToolCall{{ID: "bash-1", Name: "bash", Arguments: map[string]any{"cmd": "echo hi"}}}}
			client := newMockClient(manyFinals(bashCall)...)
			engine := New(client, registry, Config{MaxSteps: 60}, DefaultPromptSpec(), WithGuard(g),
				WithEngineToolsConfig(EngineToolsConfig{PathRoots: pathroots.New(root, "", "")}))

			pending, _, err := engine.Run(context.Background(), tc.task, RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			approvalID := pendingApprovalID(t, pending)
			if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
				t.Fatalf("ResolveApproval() error = %v", err)
			}
			if tc.writeFile != "" {
				full := filepath.Join(root, tc.writeFile)
				if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(full, []byte("content"), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			final, _, err := engine.Resume(context.Background(), approvalID)
			calls := client.allCalls()
			if tc.wantErr {
				unsat := unsatisfied(t, err)
				if unsat.Interventions != maxFileWriteNoProgress || len(calls) != 2+maxFileWriteNoProgress {
					t.Fatalf("interventions = %d, llm calls = %d", unsat.Interventions, len(calls))
				}
				return
			}
			if err != nil {
				t.Fatalf("Resume() error = %v", err)
			}
			if final == nil || final.Output != "done 0" || len(calls) != 2 || reminderCount(calls) != 0 {
				t.Fatalf("final = %#v, llm calls = %d, reminders = %d", final, len(calls), reminderCount(calls))
			}
		})
	}
}

func TestResumeStateKeepsFileWriteGuard(t *testing.T) {
	want := fileWriteGuardState{Interventions: 2, Unchanged: 1, LastMissing: []string{"a.md"}}
	raw, err := json.Marshal(resumeState{RunID: "r", FileWriteGuard: cloneFileWriteGuardState(want)})
	if err != nil {
		t.Fatal(err)
	}
	var got resumeState
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.FileWriteGuard.Interventions != 2 || got.FileWriteGuard.Unchanged != 1 || !slices.Equal(got.FileWriteGuard.LastMissing, want.LastMissing) {
		t.Fatalf("guard after a round trip = %#v, want %#v", got.FileWriteGuard, want)
	}

	// A state saved before the guard was kept resumes with a fresh budget.
	raw, err = json.Marshal(resumeState{RunID: "r"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "file_write_guard") {
		t.Fatalf("an unused guard is written: %s", raw)
	}
	var old resumeState
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}
	if old.FileWriteGuard.Interventions != 0 || len(old.FileWriteGuard.LastMissing) != 0 {
		t.Fatalf("guard of an older state = %#v, want zero", old.FileWriteGuard)
	}
}

func TestMissingRequestedWrites(t *testing.T) {
	workspace := t.TempDir()
	cache := t.TempDir()
	cwd := t.TempDir()
	t.Chdir(cwd)
	mustWrite := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite(filepath.Join(workspace, "design", "mobile-popups.md"))
	mustWrite(filepath.Join(workspace, "My Notes", "final report.md"))
	mustWrite(filepath.Join(cache, "cached.md"))
	mustWrite(filepath.Join(cwd, "local.md"))
	mustWrite(filepath.Join(workspace, "plain"))
	if err := os.MkdirAll(filepath.Join(workspace, "docs.d"), 0o700); err != nil {
		t.Fatal(err)
	}
	roots := pathroots.New(workspace, cache, "")

	cases := []struct {
		name        string
		path        string
		wantMissing bool
		wantSkipped bool
		wantProblem string
	}{
		{name: "file in the workspace", path: "design/mobile-popups.md"},
		{name: "file with spaces", path: "My Notes/final report.md"},
		{name: "file in the cache dir", path: "cached.md"},
		{name: "file in the working directory", path: "local.md"},
		{name: "workspace alias", path: "workspace_dir/design/mobile-popups.md"},
		{name: "cache alias", path: "file_cache_dir/cached.md"},
		{name: "absolute file", path: filepath.Join(workspace, "design", "mobile-popups.md")},
		{name: "empty", path: ""},
		{name: "blank", path: "   "},
		{name: "missing file", path: "design/other.md", wantMissing: true},
		{name: "other case", path: "design/Mobile-Popups.MD", wantMissing: true},
		{name: "missing under alias", path: "file_cache_dir/design/mobile-popups.md", wantMissing: true},
		{name: "prose fragment", path: "the de", wantMissing: true},
		{name: "missing absolute file", path: filepath.Join(workspace, "nope.md"), wantMissing: true},
		{name: "directory", path: "design", wantSkipped: true},
		{name: "directory with a dot", path: "docs.d", wantSkipped: true},
		{name: "under a regular file", path: "plain/inner.md", wantMissing: true, wantProblem: "cannot be checked"},
		{name: "nul byte", path: "bad\x00name.md", wantMissing: true, wantProblem: "cannot be checked"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "other case" {
				if _, err := os.Stat(filepath.Join(workspace, "design", "Mobile-Popups.MD")); err == nil {
					t.Skip("case-insensitive filesystem")
				}
			}
			missing, skipped := missingRequestedWrites(roots, []string{tc.path})
			if (len(missing) == 1) != tc.wantMissing || (len(skipped) == 1) != tc.wantSkipped {
				t.Fatalf("missing = %v, skipped = %q, want missing %v, skipped %v", missing, skipped, tc.wantMissing, tc.wantSkipped)
			}
			if !tc.wantMissing {
				return
			}
			if missing[0].Path != tc.path || len(missing[0].Checked) == 0 {
				t.Fatalf("missing = %#v, want the path and where it was checked", missing[0])
			}
			if !strings.Contains(missing[0].Problem, tc.wantProblem) || (tc.wantProblem == "" && missing[0].Problem != "") {
				t.Fatalf("problem = %q, want %q", missing[0].Problem, tc.wantProblem)
			}
		})
	}
}

// A file named without an extension is still a file the run has to write.
func TestFileWriteGuardEnforcesExtensionlessFiles(t *testing.T) {
	cases := []struct {
		name  string
		task  string
		write string
	}{
		{name: "backticked Makefile", task: "Draft the build and write to `Makefile`.", write: "Makefile"},
		{name: "bare LICENSE", task: "Pick a license and save it to LICENSE", write: "LICENSE"},
		{name: "dot relative path", task: "Render it and output to ./build/output", write: "build/output"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			engine, client, writer, _ := writeGuardEngine(t, true, manyFinals(
				finalResponse("early"),
				writeCall(tc.write),
			)...)
			final, _, err := engine.Run(context.Background(), tc.task, RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			calls := client.allCalls()
			if final == nil || final.Output != "done 0" || len(calls) != 3 || reminderCount(calls) != 1 || len(writer.paths) != 1 {
				t.Fatalf("final = %#v, llm calls = %d, reminders = %d, writes = %q", final, len(calls), reminderCount(calls), writer.paths)
			}
		})
	}

	t.Run("never written", func(t *testing.T) {
		engine, client, _, _ := writeGuardEngine(t, true, manyFinals()...)
		missing := filepath.Join(t.TempDir(), "out")
		_, _, err := engine.Run(context.Background(), "Save it to "+missing, RunOptions{})
		unsat := unsatisfied(t, err)
		if !slices.Equal(missingPaths(unsat), []string{missing}) || len(client.allCalls()) != 1+maxFileWriteNoProgress {
			t.Fatalf("missing = %q, llm calls = %d", missingPaths(unsat), len(client.allCalls()))
		}
	})
}

// An extensionless path that is a directory, or is called one, asks for nothing.
func TestFileWriteGuardExtensionlessDirectoryCompletes(t *testing.T) {
	dir := t.TempDir()
	for _, task := range []string{
		"Save it to " + dir,
		"Write the notes and save it to `build` folder",
		"Save it to ./build/output directory",
		"Write it down and save it to disk",
	} {
		t.Run(task, func(t *testing.T) {
			engine, client, _, _ := writeGuardEngine(t, true, manyFinals()...)
			final, _, err := engine.Run(context.Background(), task, RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if calls := client.allCalls(); final == nil || len(calls) != 1 || reminderCount(calls) != 0 {
				t.Fatalf("final = %#v, llm calls = %d, reminders = %d", final, len(calls), reminderCount(calls))
			}
		})
	}
}
