# Integration

## Embedding to other projects

Two common integration options:

- As a Go library: see `demo/embed-go/`.
- As a subprocess CLI: see `demo/embed-cli/`.

For Go-library embedding with built-in wiring, use `integration`:

```go
cfg := integration.DefaultConfig()
cfg.BuiltinToolNames = []string{"read_file", "url_fetch", "todo_update"} // optional; empty = all built-ins
cfg.AddPromptBlock(`[[ Project Policy ]]
- Keep answers under 3 sentences unless asked for detail.`) // optional; appended under "Additional Policies"
cfg.Inspect.Prompt = true   // optional
cfg.Inspect.Request = true  // optional
cfg.Set("llm.routes", map[string]any{
	"main_loop": map[string]any{
		"candidates": []map[string]any{
			{"profile": "default", "weight": 1},
			{"profile": "cheap", "weight": 1},
		},
		"fallback_profiles": []string{"reasoning"},
	},
})
cfg.Set("llm.api_key", os.Getenv("OPENAI_API_KEY"))

rt, err := integration.NewChecked(cfg)
if err != nil { /* ... */ }

reg := rt.NewRegistry() // built-in tools wiring
prepared, err := rt.NewRunEngineWithRegistry(ctx, task, reg)
if err != nil { /* ... */ }
defer prepared.Cleanup()

final, runCtx, err := prepared.Engine.Run(ctx, task, agent.RunOptions{Model: prepared.Model})
_ = final
_ = runCtx
```

`NewChecked` validates the runtime configuration before returning a usable
runtime. It does not make network requests or connect MCP servers. The legacy
`New` constructor remains available for compatibility; callers using it should
check `rt.Err()` before creating registries, engines, or bots.

## Capability matrix

| Capability | `NewRunEngine` / `RunTask` | `NewTelegramBot` | `NewSlackBot` |
| --- | --- | --- | --- |
| Configured built-in tools | Yes | Yes | Yes |
| Per-task references to enabled tools such as `$bash` | Yes | Yes | Yes |
| Configured `image_generate` and `image_edit` tools | Yes | Yes | Yes |
| MCP tools from `mcp.servers` | Yes | Yes | Yes |
| Skills, Guard, prompt blocks, and LLM routes | Yes | Yes | Yes |
| Elevated commands (`elevated` on `bash`/`powershell`; off by default, see [Elevated commands](#elevated-commands)) | Yes | Yes (the dialog shows on the bot's machine) | Yes (the dialog shows on the bot's machine) |

The Integration package does not currently expose LINE or Lark bot constructors. Use the CLI for those channel runtimes.

`PreparedRun` owns the LLM, image, inspector, and MCP resources created while preparing that run. Always call `PreparedRun.Cleanup`; repeated calls are safe. Telegram and Slack runners connect MCP servers with the context passed to `Run` and close those connections when `Run` exits. `BotRunner.Close` cancels an active run.

Integration uses its configured logger without changing the host process's default `slog` logger.

Set `workspace_dir` to an existing project directory when direct integration runs need a default workspace. `NewChecked` validates it, and `RunTask`, `NewRunEngine`, and registries returned by `NewRegistry` use the same directory. An empty value preserves the existing file-cache fallback.

## Tool search and codemode for embedder tools

`RunTask`, `RunTaskWithOptions`, `NewRunEngine` and the bots honor `tools.tool_search` and `tools.codemode` like the CLI does; both are on by default. `BuiltinToolNames` does not select them: turn them off with `cfg.Set("tools.tool_search.enabled", false)` or `cfg.Set("tools.codemode.enabled", false)`.

Tools in the registry you pass can opt in to two optional interfaces from the `tools` package. A tool that wraps another must forward them.

```go
// Deferred: tool_search keeps the tool out of requests until the model finds it, like MCP tools.
// Use it when you bring many tools, for example from an MCP client you run yourself.
func (t *myTool) Deferred() bool { return true }

// CodeModeExcluded: codemode scripts cannot call the tool, so the model calls it directly.
// Use it for a tool that asks the user before it acts.
func (t *myTool) CodeModeExcluded() bool { return true }
```

With a `TopicID`, `RunTaskWithOptions` treats the topic as one conversation: the tools a turn finds through `tool_search` are saved under the context checkpoint root and stay visible on the topic's later turns. Other topics start from the default tool list.

## Elevated commands

The `bash` tool (Linux, macOS) and the `powershell` tool (Windows) can run a command as root or
administrator after the user approves it in a system dialog that shows the command. The model asks
for it with `elevated: true`; it never writes `sudo` itself. How it works and why it is safe:
[Elevated commands](tools.md#elevated-commands) and
`docs/feat/feat_20261024_elevated_commands.md`.

Embedded programs have it off by default. To turn it on:

```go
func main() {
	// First thing in main: before flags, logging, or anything that writes to stdout.
	integration.RunAskpassIfRequested()

	cfg := integration.DefaultConfig()
	cfg.Set("tools.bash.elevation.enabled", true)       // Linux, macOS
	cfg.Set("tools.powershell.elevation.enabled", true) // Windows
	rt := integration.New(cfg)
	// ...
}
```

### Why the call in `main`

On Linux and macOS an elevated command runs under `sudo -k -A`. sudo reads the password from an
askpass program, and the program it starts is the running executable: yours. When your program is
started that way (`MISTERMORPH_ASKPASS=1`), `RunAskpassIfRequested` shows the approval dialog,
writes the password to stdout for sudo, and exits with `os.Exit`. In any other start it returns at
once. So:

- Call it before anything writes to stdout: in askpass mode stdout carries the password to sudo.
- Call it before setting anything up: in askpass mode it exits without running deferred functions.
- Until it has run, elevated commands are unavailable on Linux and macOS, even with
  `tools.bash.elevation.enabled` set: `bash` does not offer `elevated`, and a call that uses it gets
  "this program does not show the approval dialog". Without the check, sudo would start a second
  copy of your program instead of a dialog.

Windows elevates through UAC, which does not use an askpass program, so it needs only the setting.
A program that brings its own askpass program does not need the call either (next section).

### Your own askpass program

If your program already has a password dialog of its own, for example one ssh and git use too, set
`tools.bash.elevation.askpass` to an askpass program that shows it. sudo then runs that program
instead of yours, and mistermorph's helper and dialogs are not used: `RunAskpassIfRequested`, a
desktop session and `tools.bash.elevation.dialog` are not needed. Only `sudo` and the program have to
exist. A bare name is looked up on `PATH`.

```go
cfg.Set("tools.bash.elevation.enabled", true)
cfg.Set("tools.bash.elevation.askpass", "/usr/lib/inua/inua-askpass")
```

The program is a standard askpass program, plus two variables and two lines for mistermorph. These
are stable, and exported as constants so your code need not copy them:

| | What it is |
| --- | --- |
| argument 1 | sudo's prompt (mistermorph passes an empty one: `-p ""`) |
| stdout, exit 0 | the password, when the user approves |
| exit non-zero | the user did not approve; sudo does not run the command |
| `MISTERMORPH_ELEVATE_COMMAND` (`integration.ElevateCommandEnv`) | the command to show the user |
| `MISTERMORPH_ELEVATE_DEADLINE` (`integration.ElevateDeadlineEnv`) | when to give up, in Unix seconds |
| `mistermorph: administrator approval was declined` (`integration.ElevateDeclinedMarker`) | the line to write to stderr when the user cancels |
| `mistermorph: administrator approval timed out` (`integration.ElevateTimedOutMarker`) | the line to write to stderr when nobody answered by the deadline |

The program also gets the desktop session's variables (`DISPLAY`, `WAYLAND_DISPLAY`,
`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` and others), through sudo.

The two lines tell the model that the user declined, or did not answer, rather than that the command
failed: told it was declined, the model does not try again unless the user asks. Without either
line, a non-zero exit reads as the command failing with sudo's own error.

### What the machine needs

The dialog appears on the machine your program runs on, so someone has to be at it.

| OS | Needs |
| --- | --- |
| Linux | `sudo`, a desktop session (`DISPLAY` or `WAYLAND_DISPLAY` in your program's environment), and a graphical pinentry, `zenity` or `kdialog`; or `sudo` and your own askpass program |
| macOS | `sudo` and `osascript` (both standard), or `sudo` and your own askpass program |
| Windows | an interactive session (not a service) |

Where these are missing, `elevated` is not offered and the tool says why. A Telegram or Slack bot can
use elevated commands too, but the dialog shows on the bot's machine, not in the chat; nobody
answering means it times out. Keep it off for headless services.

### Settings

| Key | Default | |
| --- | --- | --- |
| `tools.bash.elevation.enabled` | `false` (`true` in the CLI) | Linux, macOS |
| `tools.bash.elevation.approval_timeout` | `2m` | how long the dialog waits, on top of the command's timeout |
| `tools.bash.elevation.dialog` | automatic | a pinentry, `zenity` or `kdialog` binary; automatic is the system's pinentry, then pinentry-gnome3/qt/gtk, `zenity`, `kdialog` |
| `tools.bash.elevation.askpass` | none | your own askpass program, used instead of mistermorph's helper and `dialog` (see [Your own askpass program](#your-own-askpass-program)) |
| `tools.powershell.elevation.enabled` | `false` (`true` in the CLI) | Windows |
| `tools.powershell.elevation.approval_timeout` | `2m` | |

When the user declines, or nobody answers in time, the command does not run and the tool returns an
error saying so; the model is told not to retry unless the user asks. Each elevated command is
logged as `elevated_command_started` and `elevated_command_finished`, with the command and the
outcome, through the process's default `slog` logger (`slog.Default()`), as other built-in tools
log; set it in your program to collect them. The password never passes through your program's agent process, the model
or the logs: it goes from the dialog (or your askpass program) to sudo.

## Prompt blocks

`integration.Config.AddPromptBlock(...)` appends static prompt content into the system prompt's `Additional Policies` section.

Use it when you want integration-level customization without dropping down to `agent.New(...)`:

- project-wide safety or style rules
- tenant- or deployment-specific policies
- static instructions that should apply to one-shot runs and channel runtimes

The same configured blocks are applied to:

- `rt.NewRunEngine(...)`
- `rt.NewRunEngineWithRegistry(...)`
- `rt.RunTask(...)`
- `rt.NewTelegramBot(...)`
- `rt.NewSlackBot(...)`

If you need per-task dynamic prompt shaping or full prompt replacement, use the lower-level `agent` APIs instead.

## Route Policies

`integration.Config.Set(...)` can also configure the same route policies used by first-party runtimes.

Use `llm.routes.<purpose>` to choose one of:

- a fixed profile, for example `plan_create: reasoning`
- a weighted candidate list for per-run traffic split
- a route-local `fallback_profiles` chain

Example:

```go
cfg := integration.DefaultConfig()
cfg.Set("llm.profiles", map[string]any{
	"cheap": map[string]any{"model": "gpt-4.1-mini"},
	"reasoning": map[string]any{
		"provider": "xai",
		"model":    "grok-4.1-fast-reasoning",
		"api_key":  os.Getenv("XAI_API_KEY"),
	},
})
cfg.Set("llm.routes", map[string]any{
	"main_loop": map[string]any{
		"candidates": []map[string]any{
			{"profile": "default", "weight": 1},
			{"profile": "cheap", "weight": 1},
		},
		"fallback_profiles": []string{"reasoning"},
	},
	"think":       "reasoning",
	"plan_create": "reasoning",
})
```

When a route uses `candidates`, one primary profile is selected once for the current run and reused for that run's LLM calls. If the selected primary fails with a fallback-eligible error, the route's `fallback_profiles` are tried in order.

`/think <task>` resolves `llm.routes.think` when present, otherwise it uses the default profile. The run then temporarily sets `reasoning_effort` to `xhigh`.

## Closed questions on the decision route

`rt.Evaluate` asks the model to choose rather than write: a yes/no answer, one of a fixed set of options, or a score. It uses `llm.routes.decision` (the route Mister Morph uses for its group reply check, so the `typesafe` provider and decision-only profiles (`abilities: [decision]`, which call OpenAI Decisions on OpenAI) work there), with the route's `candidates` and `fallback_profiles`. Without that route it uses the default profile. It does not build a system prompt or run the agent loop, so it is much faster than `RunTaskWithOptions` for a choice from a known list.

```go
res, err := rt.Evaluate(ctx, llm.EvaluateRequest{
	Scene: "game.move", // optional; defaults to "integration.evaluate"
	State: map[string]any{"board": board, "to_move": "white"},
	Questions: map[string]llm.Question{
		"move": {
			Kind:         llm.Choice,
			Instructions: "Pick the strongest legal move.",
			Options:      map[string]any{"a": "e2e4", "b": "d2d4", "c": "g1f3"},
		},
	},
}, integration.EvaluateOptions{})
if errors.Is(err, llm.ErrEvaluateUnsupported) {
	// This profile can't evaluate; ask with RunTaskWithOptions instead.
}
move := res.Answers["move"].Selected // "a", "b" or "c"
```

`EvaluateOptions.Profile` asks a named profile instead of the route. An empty `Model` in the request uses the route's model. Usage is recorded in the LLM usage journal like other calls.

## Runtime LLM Profile Selection

`integration.Runtime` also exposes runtime-level helpers for reading and overriding the current `main_loop` LLM profile selection:

- `rt.GetLLMProfileSelection()`
- `rt.ListLLMProfiles()`
- `rt.SetLLMProfile(profileName)`
- `rt.ResetLLMProfile()`

These methods are scoped to one `integration.Runtime` instance, not process-global state.

- If your host creates one runtime, the behavior feels global inside that host.
- If your host creates multiple runtimes, each runtime keeps its own selection state.
- `ResetLLMProfile()` clears the manual override and returns to the configured `llm.routes.main_loop` policy.

Example:

```go
selection, err := rt.GetLLMProfileSelection()
if err != nil { /* ... */ }

profiles, err := rt.ListLLMProfiles()
if err != nil { /* ... */ }

if len(profiles) > 0 {
	if err := rt.SetLLMProfile(profiles[0].Name); err != nil { /* ... */ }
}

rt.ResetLLMProfile()
```

`GetLLMProfileSelection()` returns a structured view of the current strategy, not always a single active profile.

- In `manual` mode, `Current` describes the forced main profile.
- In `auto` mode with `llm.routes.main_loop: some_profile`, `Current` describes that resolved profile.
- In `auto` mode with `llm.routes.main_loop.candidates`, `RouteType` is `candidates`, `Candidates` lists the weighted profiles, and `Current` may be empty because the configured strategy is not a single fixed profile.

This override only changes `main_loop`. Other purposes such as `plan_create` still follow config unless you explicitly change their routes.
