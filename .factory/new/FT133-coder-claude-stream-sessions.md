---
---
# Coder: Claude Code on `claude -p` sessions, and no terminal

## factory · 2026-11-16 00:58
Recorded from the owner's request to add this as a task and have the factory implement it.

Owner request:
> here is the plan:
> 1. always use claude -p for claude
> 2. use codex app server for codex
> 3. use acp for agy.
>
> my goal is simplify the implement and make sure the coder doesn't against the rules.
>
> so i asked codex to implement some code, but this task is not complete yet.
>
> and add a new task in factory, let the factory to implement it.

"The rules" are the rule of `docs/feat/feat_20261113_coder_usage_quota.md`: MisterMorph never reads the coding CLIs' credentials, never calls their services, and never reads their interactive screens. The owner's concern here is the screen reading of the Console's terminal sessions.

**Where the work starts**

The first part is on the branch `feat/coder-sessions` (commit `7bdbbfa1`, pushed to origin, not in `master`): Codex on `codex app-server` and the Antigravity CLI on `agy acp`, as sessions in every runtime (`internal/codersessions`), with the scopes and the approval rule. This item finishes that work, so it builds on that branch, not on `master` alone: merge `origin/feat/coder-sessions` into the item's branch before anything else (the ref is already in the clone; no fetch is needed). Its commits are part of this item and are reviewed with it.

`go build ./...` and `go vet` passed on that commit. `go test ./...` was never run on it: run it first, and fix what fails in the code that branch added before building further.

Read `docs/feat/feat_20261116_coder_sessions_everywhere.md` on that branch. It has the plan, what is built, the lines a real `claude -p` stream run wrote (Claude Code 2.1.325), and the remaining work this item is.

**What to build**

- A Claude Code backend in `internal/codersessions`, beside Codex and agy: one process per session,

  ```text
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --include-partial-messages --permission-prompt-tool stdio \
    --session-id <uuid> --permission-mode default        # a Console session that asks
    --session-id <uuid> --dangerously-skip-permissions   # every other run, and bypass_approvals.claude
    --resume <uuid> …                                    # reopened
  ```

  - A task is one `{"type":"user","message":{"role":"user","content":"…"}}` line on stdin; the process stays up for the next task. A task ends with its `result` line.
  - The answer and the progress come from the events the one-shot run reads today: move the parsing of `coderStreamCollector.consumeClaude` to the backend, reset per task.
  - A permission prompt is a `control_request` whose `request.subtype` is `can_use_tool` (`tool_name`, `input`, `description`, `tool_use_id`). Ask the user through the request's `Ask` and answer `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}` or `{"behavior":"deny","message":"…"}`. A denied action does not end the task.
  - Claude Code's own question is the same request with `tool_name` `AskUserQuestion` and `input.questions` (question, header, options): show it as a question card and answer with `allow` and `updatedInput.answers` (`{question: answer}`). In a run that cannot ask, the task fails with the question as its error and the process is closed, as for Codex and agy.
  - A task's usage is `result.model_usage_since_last_result` (per model: tokens, cache reads and writes, `costUSD`). `result.modelUsage` and `total_cost_usd` are running totals of the process and must not be recorded per task. Rows are as a one-shot run's today: the CLI's list price, marked estimated.
  - The quota is `rate_limit_event`, as in the one-shot run.
  - Cancel, failure, a dead process and a changed `bypass_approvals` setting behave as for the other two backends: the process is closed and the next task of the scope reopens the session with `--resume`.
- All three coders go through `RunSessions`. Remove Claude Code's two old paths:
  - `agent.WithCoderTerminal`, `coderToolDeps.RunTerminal` and `RunCLI`, `runCoderCLI`, `buildCoderCLICommand` and the one-shot diagnostics in `agent/coder_tool.go`, and the Claude Code branch in `coderTool.Execute`.
  - In `taskruntime`: the terminal sessions (`CoderSessions`), `coderTerminalReport` and the `coderterm.Supported` condition.
  - `internal/coderterm`: the PTY session, the Claude Code backend, its screen parser and transcript reader, and the Claude Code half of `usage.go`. Move what `codersessions` still uses (Codex's rollout usage reader, the `Question` and `Answer` types) into `codersessions` and delete the package. Drop the `creack/pty` and `charmbracelet/x/vt` dependencies and the `screen` files added to the ultraviolet replacement when nothing else uses them.
- Keep: `coderusage.ReadClaudeQuota` (`claude -p /usage`, for the quota refresh), and `llm_requests.pricing_parts` with `llmstats.catalogCost`'s pricing by parts, so rows already written are still repriced when the catalog changes.
- Nothing may read a CLI's screen when this is done. Codex's rollout files stay its usage source, as the doc says.
- Docs and config: `docs/tools.md` (the `coder` paragraphs), `assets/config/config.example.yaml` (the comments on terminal sessions), the tool description; mark `feat_20261031_claude_controlled_terminal.md` and Part 1 of `feat_20261115_coder_usage_console_and_chart.md` as superseded; set the doc of this work to `implemented` and bring its "Where this stands", "Claude Code" and "Remaining work" parts up to what was built.

**Out of scope**

Sessions kept per Telegram or Slack chat and approvals there; checking the backends on Windows; changing rows already in `usage.db`; an interrupt of a running Claude Code task over the stream (closing the process is enough).

**Checking**

- A stand-in `claude` replaying the lines in the doc: two tasks on one process with each one's answer and usage, a permission allowed and denied, the question tool, a bypassed session's flags and a question in it, a cancelled task, a process that died and the resume, the quota.
- `agent/coder_usage_test.go`: Claude Code's usage and quota arrive in one report and the rows in `usage.db`, through the session path.
- `internal/llmstats`: rows with pricing parts already in a file are still repriced after a catalog change.
- An opt-in test against the installed CLI (as `MISTERMORPH_TEST_CLAUDE=1` is today): a task in a bypassed session, and a second task that needs the first one's context.
- Say in the report what was not checked against a real CLI.
