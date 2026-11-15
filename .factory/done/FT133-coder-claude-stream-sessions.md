---
branch: factory/FT133-coder-claude-stream-sessions
round: 1
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


## factory · plan · 2026-11-16 01:37

## Behaviour
Merge the already fetched origin/feat/coder-sessions into the item branch first; run go test ./... immediately and correct regressions introduced by that branch. All coder requests then use RunSessions: Claude starts claude -p with streaming JSON stdin/stdout, reuses a scope's process across tasks, resets task answer/progress/usage collectors on each user message, and completes only at result. Empty answers must not retain a previous task's content. Permission denial responds deny and continues; AskUserQuestion uses cards with answers in updatedInput; an unaskable question fails the task and closes the process. Cancellation, protocol/process errors and approval-setting changes close/reopen with resume. Only model_usage_since_last_result is task usage; quota is read from stream events. Existing pricing_parts rows retain repricing behavior.

## Scope
Includes all prerequisite branch commits, a Claude session backend, removal of PTY and one-shot paths, migration of shared types and Codex rollout accounting out of coderterm, dependency cleanup, regression tests and the requested documentation/config comments. Preserves quota refresh, Codex rollout accounting and legacy pricing_parts. Excludes chat-wide sessions outside Console, Windows validation, usage.db migration and stream interrupts.

## Decisions
Use the existing session manager and lifecycle conventions rather than a parallel runner. Stream events are the sole source of Claude answers/progress; never read screens, credentials or services. Persist a UUID for resume; failures do not silently retry user actions. Handle approvals only when the runtime explicitly allows asking; other runtimes bypass permissions but cannot synthesize answers to CLI questions. Use recorded protocol fixtures/stand-ins for deterministic coverage; keep real-CLI tests opt-in without spending live quota by default.

## Checking
Add stand-in coverage for two tasks/one process with independent answers and usage, allow/deny permissions, question answers and unaskable questions, bypass flags, cancellation, process death/resume, quota and approval changes. Exercise combined Claude usage/quota through agent session reporting and usage.db; retain/add legacy pricing-parts repricing coverage. Add opt-in real Claude contextual second-turn test. Run required gofmt, go vet ./..., go test ./... with scripted tests using an absolute throwaway HOME, preserving explicit toolchain/module caches. If Console sources change run nsh check and scripts/test.sh. Report any real CLI or UI behavior not exercised.

## factory · 2026-11-16 01:37

Built Claude Code streaming sessions and routed all three coders through RunSessions. Removed the terminal/one-shot paths and internal/coderterm; retained Codex rollout accounting, Claude quota refresh, and legacy pricing_parts repricing. Updated docs, config comments and approval settings notes. Includes prerequisite origin/feat/coder-sessions and its usage/chart prerequisite commit, as required by the item. Final head: acc8d33a.

Decisions: task usage comes exclusively from model_usage_since_last_result; when missing, no usage is recorded (the first implementation's running-total delta fallback was removed before pushing). Failed/cancelled sessions reopen with resume; sessions with no valid CLI reply may start with a fresh id. No live quota-spending tests were run.

Installs/dependencies: no unpinned tools installed. Removed creack/pty, charmbracelet/x/vt and indirect charmbracelet/x/exp/ordered from go.mod; go.sum removes six lines. Pinned dependency restoration only.

Tests: prerequisite go test ./... passed before further work. Manager independently verified clean gofmt, go vet ./... and go test ./... on final committed head using an absolute throwaway HOME. Coder additionally reports codersessions race tests (-count=8), Windows cross-build, darwin/arm64 package build, nsh check, Console test script (125 files, one concurrent failure passed isolated rerun), and 268 core node tests passing. New stand-in and agent/storage regression tests cover session reuse, task isolation, approvals/questions, cancellation/failure/resume, quota, running-total exclusion and legacy pricing-parts repricing.

Not checked: real Claude/Codex/agy task runs or approvals; real bypassed Claude questions, sub-agent usage and num_turns semantics. Opt-in contextual real-Claude test added but not run. UI changed (agy approval-toggle notes/settings); permission/question cards and settings were NOT looked at in a browser. Windows execution not tested (cross-build only).

Recovery/process notes: numbering push initially failed because credential.useHttpPath was absent; retry with repository path succeeded. No base branch or tags pushed. Next: review the full prerequisite and implementation diff, especially protocol lifecycle and usage reporting.


## factory · review · 2026-11-16 01:53
head: acc8d33a4ffd30ac8d82d1ba30e62efb433f1464
verdict: pass
notes:
- [P2] internal/codersessions/claude.go:91: a missing resumed session produces an error result, setting heard=true and resumable=true, so every later task resumes the same missing id. Clear the session identity when reopening fails before initialization. Example: Claude Code 2.1.325 emits error_during_execution with num_turns=0 and "No conversation found with session ID" for an unknown UUID; replaying it made three successive tasks resume that UUID and fail.
- [P2] cmd/mistermorph/consolecmd/local_runtime.go:2910: CoderCanAsk=true also applies to non-chat Console triggers whose ask callback is nil, leaving approvals enabled but unanswerable. Set it from consoleAsksUser(job.Trigger), or require a nonnil callback. Example: CoderSessionRunner with canAsk=true and ask=nil makes approve tasks fail with "coder needs a user answer" for all three stand-ins; agy previously bypassed approvals.
- [P3] internal/codersessions/codex.go:71: a quota-read response arriving after its ignored 15-second timeout is parsed as a method notification during the next task; empty Params cause unexpected end of JSON input and close the session. Ignore stale responses without a method. Example: a stand-in delaying the first quota response 16 seconds returned done 1 for task one and unexpected end of JSON input for task two.

Review: Claude Code reviewed origin/master...HEAD, including both prerequisite commits. No P0/P1 findings; pass under factory policy, with the P2/P3 defects above retained for owner attention.

Validation reported by reviewer: required gofmt gate, go vet ./..., go test ./... passed with an absolute throwaway HOME; nsh check passed; Console script passed all 125 files (four initial concurrent failures passed isolated retries). Three temporary probe tests reproduced the findings; removed afterward. Two signed-out real Claude protocol checks used an empty HOME and no model calls. No unpinned installs, no manifest changes, no commits or remaining tracked/untracked worktree edits; manager verified clean status and reviewed head.

Residual risks: no real Claude/Codex/agy model task or live approvals; no browser visual check of usage chart/settings; Windows not executed. Late Claude lines after result, control_cancel_request, sub-agent usage and num_turns semantics remain unverified. Codex rollout-lag fallback loses per-model pricing for that session by design. No linked issue or PR in the item.


## factory · 2026-11-16 07:09
Shipped to master with Claude Code. Merge commit: 5983b0587fa92dff46e692f0d5044da1633cae26. Merge tree is identical to reviewed head acc8d33a; no integration edits or conflicts. Pushed and verified remote master. No tag created or pushed, per owner request. No linked issue or PR. Branch not deleted (clean not requested).

Final merged-HEAD checks passed: gofmt, go vet ./..., go test ./..., nsh check, Console scripts/test.sh (125 files, zero final failures; chat-attachments passed isolated retry after concurrent failure), and 277 Node tests. Absolute throwaway HOME used. No unpinned installs reported. Existing P2/P3 findings retained as reviewed (missing Claude resume identity, non-chat approval callback, late Codex quota response). No live model/CLI approval tests, browser/device checks or native platform execution performed during shipping.
