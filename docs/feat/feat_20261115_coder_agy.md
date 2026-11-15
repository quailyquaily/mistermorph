---
date: 2026-11-15
title: "Coder: the Antigravity CLI (agy) as a third coder"
status: implemented
---

# Coder: the Antigravity CLI (agy) as a third coder

## Goal

Google moved its terminal agent from Gemini CLI to the Antigravity CLI (`agy`); for subscription users `agy` is the Google coder. The `coder` tool runs it beside Codex and Claude Code (`coder=agy`), records what its runs use, and shows its subscription quota, as [`feat_20261113_coder_usage_quota.md`](feat_20261113_coder_usage_quota.md) does for the other two.

## Sources

Only what the CLI itself reports. MisterMorph never reads its credentials or calls its services. Checked against agy 1.5.9 on Linux, signed in with a Google account (2026-11-15), and the docs: <https://antigravity.google/docs/cli/headless/>, <https://antigravity.google/docs/cli/commands/usage/>, <https://antigravity.google/docs/cli/acp/>.

| | Source |
|---|---|
| Run | `agy --output-format stream-json --dangerously-skip-permissions`, the task on stdin. One JSON object per line: `init` (`cwd`, `tools`, `permission_mode`), a `step_update` per step transition and text delta (`step_index`, `state` `ACTIVE`/`DONE`, `step_type` `user_input`/`agent_response`/`tool`/`checkpoint`, `text_delta`, `tool_name`, `tool_info` with `parameters`, `output` and on failure `error.type`/`error.message`, `subagent_info`, `usage`), then one `result` (`status`, `response`, `error`, `num_turns`, `usage`, `denied_actions`). |
| Run usage | `usage` on each finished `agent_response` step and on `result`: `input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`. No cost. No model name unless the run is given `--model`. |
| Quota | `agy -p /usage --output-format json`, answered by the CLI itself (no model, 0 tokens, empty `conversation_id`): `command.data.groups[]`, each a model group (`name`, `description` "Models within this group: …") with `buckets[]` (`id`, `window`, `remaining_fraction`, `reset_time`). |

Facts the behaviour rests on, each seen on the real CLI unless marked:

- The prompt: `-p <task>` or stdin. With no `-p` and a task on stdin, `--output-format stream-json` runs headless just the same; a task that starts with `-` or has several lines is taken as written. The task goes on stdin, as for the other coders, so it is not in the process list and not bounded by the argument size. (`-p` followed by another flag takes that flag as its prompt.)
- Without `--dangerously-skip-permissions` a headless run cannot ask: an action that needs approval is denied, and the run still exits 0 with `status` `SUCCESS`, an empty `response` and `denied_actions`. With the flag, `init.permission_mode` is `always-proceed`.
- Exit codes (docs): 0 for a successful run, also one with denied actions; 1 for a failed run. `status` is one of `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, `RUNNING`.
- Not signed in: stderr prints `Authentication required. Please visit the URL to log in:`, a sign-in link, and `Waiting for authentication (timeout 60s)...`; after the wait, `result` has `status` `ERROR` and `error` `authentication failed or timed out`, exit 1. The docs say a run without a terminal fails at once; 1.5.9 waits the minute.
- Cached reads are not in `input_tokens`. A real run with two model calls reported, for the first, `input_tokens` 8651 and `cache_read_tokens` 0; for the second, whose prompt was the first one plus a tool's output, `input_tokens` 2355, `cache_read_tokens` 6612 and `total_tokens` 2547 (= 2355 + 192 output). Its `result.usage` was the two steps' sum: 11006 input, 6612 cached, 419 output, 331 thinking. So `total_tokens` is input plus output, and the cached reads come on top of both.
- `thinking_tokens` are part of `output_tokens`: a run that answered `ok` reported 99 output and 98 thinking tokens.
- `num_turns` counts the user's turns, not the model calls: 1 for the two-call run.
- On Linux the CLI finds its sign-in with only `HOME` and `PATH` in its environment (checked with `env -i`); `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` made no difference.

## Behaviour

- `coder=agy` is accepted beside `codex` and `claude`. It always runs as a one-shot CLI subtask, in the Console too: there is no terminal session for it (its conversations are SQLite files with binary steps, which cannot be followed as the other CLIs' session files are), so there are no approval prompts and nothing is kept between tasks. The tool description says so. Codex and Claude Code keep their terminal sessions.
- Progress: a line when the run starts (with its permission mode), the answer's text deltas as they come, a line per tool step when it starts (its name and what it runs: `$ <command>` for `run_command`, else its parameters) and when it ends (its output, or `type: message` of its failure), a line per sub-agent and per checkpoint. Tool names map to the same step labels as the other coders' ("running a command", "editing files", …), which the chat channels' "still working" notices use.
- The answer is `result.response`; the run's usage is `result.usage` and its turns `num_turns`. The steps' usage and the result's are never added together: the result's is a one-shot run's total. Only when the run ends without a result (it was stopped) is the sum of its finished steps recorded instead.
- A failed run, said plainly in the tool result, whatever the exit code:
  - `status` other than `SUCCESS`, with its `error`;
  - a non-empty `denied_actions`, naming them (`Bash (command)`): never an empty success;
  - a stdout line that is not JSON;
  - no `result` event;
  - not signed in: the run is stopped as soon as the sign-in prompt appears on stderr (not after the CLI's 60 seconds), and the error is `agy is not signed in: run agy once in a terminal and sign in with a Google account, then try again`. The sign-in link is kept out of the result and the activity (it stays in the local `stderr.log`). The quota is not read after such a run.
  - `agy` not found: `agy executable not found in PATH` (it is in none of the directories below; set `tools.coder.path_extra`).
- Usage rows in `usage.db` as the other coders': host and provider `antigravity-cli`, operation and scene `coder`, model `agy`, tokens only. `InputTokens` is `input_tokens + cache_read_tokens` (llmstats counts every input token, cached ones included) and `CachedInputTokens` is `cache_read_tokens`; `OutputTokens` is `output_tokens`; `thinking_tokens` go to `ModelUsage.ReasoningTokens`, where Codex's reasoning tokens go (a part of the output, not a row column).
- Quota: read with `agy -p /usage --output-format json` after each agy run and in `POST /stats/coder/quota/refresh`, kept in `coder_quota`, returned by `GET /stats/coder/quota`. `coderusage.Quota` gained optional group data: a `Window` has `group` (the model group it is a limit of) and the quota has `groups` (`name`, `models`); quotas saved before, and the other coders', have neither. A window's `kind` is the bucket's `id` (`gemini-weekly`), its length comes from `window` (`weekly`; the five-hour bucket's word is not documented, so `five_hour`, `five-hour`, `5h` and the like are read, from `window` or the `id`), and used is `1 - remaining_fraction`. A window with nothing left is `rejected`; from 90% used it is `allowed_warning` (the CLI gives no warning of its own; 90% is where the Console's bars turn red). The quota's own status is `rejected` only when every group has a window at its limit, and `allowed_warning` when any window is near or at one: one group at its limit leaves the other groups' models usable.
- A quota read that fails (the CLI fails, answers no groups, or is not signed in) saves nothing and makes nothing up: the tool result keeps the run's usage and outcome without a quota, and the refresh route reports the reason under `errors.agy`, keeping the last saved quota. The read stops at the sign-in prompt too.
- The usage line of the tool result and the run's last activity line: `agy run: 17.6k in (6.6k cached) · 419 out · 1 turn; agy quota: Gemini Models 7d 1% used (resets in 6d 23h), Claude and GPT models 7d 0% used (resets in 6d 23h)`. A group's window nearly used up says `(nearly used up)`, one at its limit `(limit reached)`, and the line ends with `; limit reached for <groups>` (or `; the limit is reached` when every group is), which the tool description tells the agent to pass on rather than retry.
- The Console's Coding agents dialog shows the Antigravity CLI as a third section. Its windows come under each group's name and models, a row per group and window as for the other coders; the bars name their group to screen readers. The button shows when any of the three CLIs is installed.
- Lookup and environment are the other coders' (`shellenv.CoderEnv`, see `docs/tools.md`), for the run, the quota read after it and the quota routes: the bash tool's environment (the PowerShell tool's on Windows) with `tools.bash.injected_env_vars`, and nothing else of the service's own; `PATH` is `tools.coder.path_extra`, `tools.bash.path_extra`, the service's `PATH`, and, only while `tools.coder.path_extra` is empty, the default install locations that exist. The installer puts `agy` in `~/.local/bin` (on Windows `%LOCALAPPDATA%\agy\bin`, per the docs); both are in the defaults. A proxy or another variable `agy` needs from the service's environment must be listed in `tools.bash.injected_env_vars`.

## Decisions and limits

- The task is sent on stdin rather than as `-p <task>` (see Sources). The quota read uses `-p /usage` as documented.
- No `--model`: the CLI's own default model is used, and the rows' model is `agy`. Choosing the model is a later item.
- The bash tool's environment and the default install locations (FT131) landed beside this: `%LOCALAPPDATA%\agy\bin` was added to the Windows defaults, and `~/.local/bin` was already one. On Linux no variable beyond `HOME` and `PATH` was needed for the sign-in when this was built, so nothing has to be listed in `tools.bash.injected_env_vars` there; the real CLI was not run again in the restricted environment itself, and macOS and Windows (keyring, lookup) were not checked.
- Persistent agy sessions with approvals in the Console (`agy acp`, or `--input-format stream-json` with `--conversation`) are a later item.
- Not checked: Windows and macOS (lookup, the keyring, the sign-in under a reduced environment); a tier with five-hour buckets (the bucket's `window` word is a guess, covered by tests with several spellings; an unknown word shows the bucket's `id` as the window's name); real sub-agent steps (`subagent_info` is documented by its fields only: an object, a list, and an object holding a list are all read); `checkpoint` steps and `tool_info.error` on a real run; the Console dialog by eye.

## Tests

- `agent/coder_agy_test.go` with stand-in `agy` CLIs replaying `agent/testdata/agy/` (the real run's stream and `/usage` answer, and streams built from the events captured for a denied command and a missing sign-in): a successful run with text and a tool step, its arguments and stdin, the usage row and the quota; a denied action, an `ERROR` result with exit 1, `CANCELED`, a line that is not JSON, no result; the sign-in prompt (stopped at once, no link in the result, no quota read) and the CLI's own sign-in error; a missing executable; one-shot agy beside terminal sessions; the run and the quota read in the coder's environment (found in a default install location, no variable of the runtime's own); documented steps the captures lack (a failed tool, a sub-agent, a checkpoint, the steps' usage without a result).
- `internal/coderusage/agy_test.go`: the cached-read accounting and the row; `/usage` with two groups, with a five-hour and a weekly bucket in one group, with `remaining_fraction` 0, with every group at its limit; failures of the answer and of the CLI; the read stopping at the sign-in prompt; groups kept in `usage.db` beside a quota without them.
- `internal/daemonruntime/server_coder_quota_test.go`: the routes with three coders, agy found in a default install location and read through a stand-in in the coder's environment, its groups in the JSON, a failed read.
- Opt-in, against the installed and signed-in CLI: `MISTERMORPH_TEST_AGY=1 go test ./agent ./internal/coderusage -run TestInstalledAgy -v` runs one harmless task in a throwaway folder through the coder tool and reads the quota. Run on 2026-11-15 (agy 1.5.9, Linux): done, `agy run: 17.6k in (6.6k cached) · 405 out · 1 turn`, two groups with a weekly window each.
- `web/console-nsh/tests/stats-coder-quota.test.tsx`: the group helper, the dialog with agy's groups and windows, and a read that says the CLI is not signed in.
