package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/proctrack"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

const (
	coderToolName      = "coder"
	coderBackendCodex  = "codex"
	coderBackendClaude = "claude"
	// The Antigravity CLI, Google's terminal agent.
	coderBackendAgy = coderusage.BackendAgy
	// Grok Build, xAI's terminal agent.
	coderBackendGrok = coderusage.BackendGrok
)

type coderTool struct {
	deps coderToolDeps
}

// CoderRequest describes one coding task. Command and Env are the CLI and its environment,
// resolved for the session runner.
type CoderRequest struct {
	Backend string
	Task    string
	CWD     string
	// CoderEnv builds the CLI's environment and finds the CLI in it.
	CoderEnv shellenv.CoderEnv
	// BypassApprovals asks a session that could ask the user to run without approval prompts.
	BypassApprovals bool
	Command         string
	Env             []string
	// Progress reports status lines. step is a short, content-free label for what the CLI
	// is doing now, such as "running a command", or "" when it has not changed.
	Progress func(summary, text, step string)
	// Process reports the OS PID of the CLI used for this task.
	Process func(pid int)
	// Report hears, once the task has ended, what it used and the quota the CLI reported (Claude
	// Code and Codex report one; nil otherwise). A run that failed for lack of a sign-in says so
	// in Run.NotSignedIn.
	Report func(run coderusage.Run, quota *coderusage.Quota)
}

func newCoderTool(deps coderToolDeps) *coderTool {
	return &coderTool{deps: deps}
}

func (t *coderTool) Name() string { return coderToolName }

func (t *coderTool) Description() string {
	return "Delegate a repository coding task to local Codex, Claude Code (cc), Antigravity (agy), or Grok Build (grok) when the user explicitly asks for that CLI. " +
		"Each coder keeps one session per working directory within this run, or within a Console conversation, so a later task can build on an earlier one. " +
		"Only a Console conversation's sessions ask the user to approve actions and show the coder's own questions; every other run has approvals bypassed, and a question the coder asks there fails the task with the question as its error. " +
		"Returns a SubtaskResult envelope. " + coderUsageNote
}

// coderUsageNote tells the model what the result's usage line is for.
const coderUsageNote = "Its usage field, when present, says what the run used and how much of that coder's subscription quota is left; " +
	"when a limit is reached or nearly used up, tell the user (and when it resets) rather than retrying."

func (t *coderTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"coder": map[string]any{
				"type":        "string",
				"enum":        []string{coderBackendCodex, coderBackendClaude, coderBackendAgy, coderBackendGrok},
				"description": "CLI backend to run: use codex for Codex CLI; use claude for Claude Code or cc; use agy for the Antigravity CLI (Google's agy); use grok for Grok Build (xAI's grok CLI).",
			},
			"task": map[string]any{
				"type":        "string",
				"description": "Self-contained task prompt for the coding CLI. Preserve requested filenames, constraints, and expected output.",
			},
			"cwd": map[string]any{
				"type":        "string",
				"description": "Optional working directory for the coding CLI. Supports workspace_dir, file_cache_dir, and file_state_dir aliases. Omit to use the current workspace.",
			},
		},
		"required": []string{"coder", "task"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

// coderEnv is the environment builder of a run: the configured one, with the variables the
// registered shell tool injects into a command now (a task can add its own to the bash tool).
func (t *coderTool) coderEnv() shellenv.CoderEnv {
	env := t.deps.Env
	if t.deps.LookupTool == nil {
		return env
	}
	if tool, ok := t.deps.LookupTool(shellenv.CoderShellToolName()); ok {
		if source, ok := tool.(shellenv.InjectedEnvSource); ok {
			env = env.WithInjectedFrom(source)
		}
	}
	return env
}

func (t *coderTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	req, err := coderRequestFromParams(ctx, params, t.deps.Roots)
	if err != nil {
		return "", err
	}
	req.CoderEnv = t.coderEnv()
	req.BypassApprovals = t.deps.BypassApprovals[req.Backend]

	runner := t.deps.Runner
	if runner == nil {
		return "", fmt.Errorf("subtask runner unavailable")
	}
	if t.deps.RunSessions == nil {
		return "", fmt.Errorf("coder sessions unavailable")
	}

	result, err := runner.RunSubtask(ctx, SubtaskRequest{
		RunFunc: func(runCtx context.Context) (*SubtaskResult, error) {
			var run coderusage.Run
			var quota *coderusage.Quota
			req.Report = func(r coderusage.Run, q *coderusage.Quota) { run, quota = r, q }
			req.Process = func(pid int) {
				RecordWorkerProcess(runCtx, req.Backend, pid)
				proctrack.AddRoot(runCtx, proctrack.Root{PID: pid, Kind: proctrack.KindCoder, Program: req.Backend, ActivityID: ToolActivityID(ctx)})
			}
			req.Progress = func(summary, text, step string) {
				EmitEvent(runCtx, nil, Event{
					Kind: EventKindToolOutput, ToolName: coderToolName, Stream: req.Backend,
					Text: text, Summary: summary, Progress: step, Status: "running",
				})
			}
			var output string
			command, env, runErr := req.CoderEnv.Command(req.Backend)
			if runErr == nil {
				req.Command, req.Env = command, env
				output, runErr = t.deps.RunSessions(runCtx, req)
			}
			if output != "" {
				req.Progress("", strings.TrimRight(output, "\n")+"\n", "")
			}

			usage := t.reportUsage(runCtx, req, run, quota)
			if runErr != nil {
				out := FailedSubtaskResult("", runErr)
				out.OutputKind = SubtaskOutputKindText
				out.Output = output
				out.Usage = usage
				return out, nil
			}
			return &SubtaskResult{
				Status:     SubtaskStatusDone,
				Summary:    summarizeSubtaskText(output),
				OutputKind: SubtaskOutputKindText,
				Output:     output,
				Usage:      usage,
			}, nil
		},
	})
	if err != nil {
		if result == nil {
			result = FailedSubtaskResult("", err)
		}
	}
	if result == nil {
		result = FailedSubtaskResult("", fmt.Errorf("coder subtask returned nil result"))
	}
	b, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// reportUsage records what a run used and the coder's quota, and says both in a line for the
// result and the activity: Claude Code reports its quota during the task; Codex's is read from its
// app server and the Antigravity CLI's from its /usage after the task (no quota used); Grok Build
// reports none, and its line has no quota part. A quota that
// cannot be read is left out: nothing is made up, and the run's own outcome stands. It returns ""
// when there is nothing to say.
func (t *coderTool) reportUsage(ctx context.Context, req CoderRequest, run coderusage.Run, quota *coderusage.Quota) string {
	var recorder *coderusage.Recorder
	if t.deps.Usage != nil {
		recorder = t.deps.Usage()
	}
	run.Backend = req.Backend
	recorder.RecordRun(ctx, run)
	// A run that found no sign-in has no quota to read (and the read would meet the same prompt).
	if quota == nil && req.Backend == coderBackendAgy && t.deps.ReadAgyQuota != nil && !run.NotSignedIn {
		if read, err := t.deps.ReadAgyQuota(context.WithoutCancel(ctx), req.CoderEnv); err == nil {
			quota = &read
		}
	}
	if quota != nil {
		recorder.SaveQuota(ctx, *quota)
	}
	var parts []string
	if summary := run.Summary(); summary != "" {
		parts = append(parts, req.Backend+" run: "+summary)
	}
	if quota != nil {
		if note := quota.Note(time.Now()); note != "" {
			parts = append(parts, note)
		}
	}
	text := strings.Join(parts, "; ")
	if text != "" && req.Progress != nil {
		line := "[" + req.Backend + "] usage: " + text + "\n"
		req.Progress(line, line, "")
	}
	return text
}

// readAgyQuota reads the Antigravity CLI's quota from its /usage, finding agy as the coder tool does.
func readAgyQuota(ctx context.Context, coderEnv shellenv.CoderEnv) (coderusage.Quota, error) {
	command, env, err := coderEnv.Command(coderBackendAgy)
	if err != nil {
		return coderusage.Quota{}, err
	}
	return coderusage.ReadAgyQuota(ctx, command, env)
}

func coderRequestFromParams(ctx context.Context, params map[string]any, roots pathroots.PathRoots) (CoderRequest, error) {
	backend, _ := params["coder"].(string)
	backend = strings.ToLower(strings.TrimSpace(backend))
	if backend == "" {
		return CoderRequest{}, fmt.Errorf("missing required param: coder")
	}
	if backend != coderBackendCodex && backend != coderBackendClaude && backend != coderBackendAgy && backend != coderBackendGrok {
		return CoderRequest{}, fmt.Errorf("unsupported coder: %s", backend)
	}
	task, _ := params["task"].(string)
	task = strings.TrimSpace(task)
	if task == "" {
		return CoderRequest{}, fmt.Errorf("missing required param: task")
	}
	cwd, _ := params["cwd"].(string)
	resolvedCWD, err := resolveCoderCWD(ctx, roots, cwd)
	if err != nil {
		return CoderRequest{}, err
	}
	return CoderRequest{
		Backend: backend,
		Task:    task,
		CWD:     resolvedCWD,
	}, nil
}

func resolveCoderCWD(ctx context.Context, roots pathroots.PathRoots, raw string) (string, error) {
	roots = pathroots.Resolve(ctx, roots)
	cwd := strings.TrimSpace(raw)
	if cwd == "" {
		if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
			cwd = workspaceDir
		} else {
			cwd = "."
		}
	}
	cwd = pathutil.ExpandHomePath(cwd)
	alias, rest := detectCoderPathAlias(cwd)
	var abs string
	var err error
	if alias != "" {
		abs, err = resolveCoderAliasedCWD(roots, alias, rest)
	} else if filepath.IsAbs(cwd) {
		abs, err = filepath.Abs(filepath.Clean(cwd))
	} else if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
		abs, err = filepath.Abs(filepath.Join(pathutil.ExpandHomePath(workspaceDir), cwd))
	} else {
		abs, err = filepath.Abs(cwd)
	}
	if err != nil {
		return "", fmt.Errorf("resolve coder cwd: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("resolve coder cwd: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("coder cwd %q is not a directory", abs)
	}
	return abs, nil
}

func detectCoderPathAlias(userPath string) (string, string) {
	trimmed := strings.TrimLeft(userPath, "/\\")
	lower := strings.ToLower(trimmed)
	prefixes := []struct {
		alias  string
		prefix string
	}{
		{alias: "workspace_dir", prefix: "workspace_dir/"},
		{alias: "workspace_dir", prefix: "workspace_dir\\"},
		{alias: "file_cache_dir", prefix: "file_cache_dir/"},
		{alias: "file_cache_dir", prefix: "file_cache_dir\\"},
		{alias: "file_state_dir", prefix: "file_state_dir/"},
		{alias: "file_state_dir", prefix: "file_state_dir\\"},
	}
	switch lower {
	case "workspace_dir", "file_cache_dir", "file_state_dir":
		return lower, ""
	}
	for _, item := range prefixes {
		if !strings.HasPrefix(lower, item.prefix) {
			continue
		}
		return item.alias, strings.TrimLeft(trimmed[len(item.prefix):], "/\\")
	}
	return "", userPath
}

func resolveCoderAliasedCWD(roots pathroots.PathRoots, alias string, rest string) (string, error) {
	base := strings.TrimSpace(roots.BaseDir(alias))
	if base == "" {
		return "", fmt.Errorf("base dir %s is not configured", alias)
	}
	baseAbs, err := filepath.Abs(pathutil.ExpandHomePath(base))
	if err != nil {
		return "", err
	}
	rest = strings.TrimLeft(strings.TrimSpace(rest), "/\\")
	if rest == "" {
		return baseAbs, nil
	}
	candidate := filepath.Join(baseAbs, rest)
	candAbs, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	if !pathutil.IsWithinDir(baseAbs, candAbs) {
		return "", fmt.Errorf("refusing to access outside allowed base dir %s", alias)
	}
	return candAbs, nil
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
