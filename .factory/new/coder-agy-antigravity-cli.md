# Coder: Antigravity CLI (agy) as a third coder, with its usage and quota

## factory · 2026-11-15 21:21
Recorded from the owner's request to put this research in new and have the factory implement it.

Owner request:
> ok, can we support agy the way like claude code and codex?
> ok. add this research report to new/ let the factory to implement them.

## Research (2026-11-15, agy 1.5.9 on Linux, signed in with a Google account)

Background: Google moved its terminal agent from Gemini CLI to Antigravity CLI (`agy`) on 2026-05-19; since 2026-06-18 Gemini CLI serves only paid API keys and enterprise licences, so `agy` is the Google coder for subscription users. Docs: https://antigravity.google/docs/cli/headless/ , https://antigravity.google/docs/cli/commands/usage/ , https://antigravity.google/docs/cli/acp/ .

Checked on a real install:

- Install: the installer (`https://antigravity.google/cli/install.sh`) puts one binary at `~/.local/bin/agy`; on Windows `%LOCALAPPDATA%\agy\bin` (docs, not checked). Data is under `~/.gemini/antigravity-cli/` (settings.json, logs, `conversations/`), credentials in the OS keyring.
- Headless: `agy -p "<task>" --output-format stream-json` prints one JSON object per line: `init`, `step_update`, `result`. Captured from a run without tools (`tools` shortened):

```
{"event":"init","conversation_id":"ceec22be-159d-4a77-9b29-4262fe8ba68c","init":{"cwd":"/work","tools":["ask_custom_permission","ask_permission","ask_question","..."],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"ceec22be-159d-4a77-9b29-4262fe8ba68c","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"ceec22be-159d-4a77-9b29-4262fe8ba68c","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello! How can I help you today?"}}
{"event":"step_update","step_update":{"conversation_id":"ceec22be-159d-4a77-9b29-4262fe8ba68c","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":3.258714702,"usage":{"input_tokens":8740,"output_tokens":84,"thinking_tokens":75,"cache_read_tokens":0,"total_tokens":8824}}}
{"event":"result","result":{"conversation_id":"ceec22be-159d-4a77-9b29-4262fe8ba68c","status":"SUCCESS","response":"Hello! How can I help you today?\n","duration_seconds":3.273824953,"num_turns":1,"usage":{"input_tokens":8740,"output_tokens":84,"thinking_tokens":75,"cache_read_tokens":0,"total_tokens":8824}}}
```

- Tool steps, from a run that asked for a shell command:

```
{"event":"step_update","step_update":{"conversation_id":"97336c2d-…","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat note.txt"}}}}
{"event":"step_update","step_update":{"conversation_id":"97336c2d-…","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.20588291,"tool_info":{"name":"run_command","parameters":{"CommandLine":"cat note.txt"}}}}
```

  The docs add `tool_info.output`, `tool_info.error` (`type`, `message`), `step_type` `checkpoint`, and `subagent_info` on sub-agent steps.
- Without approval bypass, headless cannot ask: that command was denied, and the run still exited 0 with an empty answer. Its `result`: `"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"Bash"}]`, and stderr said `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. …`.
- `--dangerously-skip-permissions` approves every tool call (`init.permission_mode` becomes `always-proceed` per the docs). The flag is in `agy --help`; a run with it was not made during the research.
- Usage: `usage` on each finished `agent_response` step and on `result` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`). In a fresh one-shot run `result.usage` is the run's total; in a resumed conversation it is cumulative over the conversation (docs). No cost. No model name unless the run was given `--model` (`init.model`).
- Not signed in: stderr prints a Google sign-in URL and waits; then `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out",…,"finished_reason":"error"}}`, exit 1.
- Exit codes (docs): 0 success (also when actions were denied), 1 failed run, 2 bad stream input. `status`: `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, `RUNNING`.
- Quota: `agy -p /usage --output-format json` is answered by the CLI itself (no model, 0 tokens, `conversation_id` empty) and carries the quota as data:

```
{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-22T12:15:22Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-22T12:15:36Z\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit. …","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.","window":"weekly","remaining_fraction":0.9972519874572754,"reset_time":"2026-11-22T12:15:22Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-22T12:15:36Z"}]}]}}}
```

  This account has only weekly buckets; the docs say groups also share a five-hour limit on some tiers. The quota is per model group and given as what remains, not what is used.
- Models (`agy models`): on this account `gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
- Sessions on disk: one SQLite file per conversation, `~/.gemini/antigravity-cli/conversations/<id>.db`, with the steps in binary blobs (tables `steps`, `gen_metadata`, `trajectory_meta`, …). It cannot be followed as the Claude Code and Codex session files are, so the Console's terminal sessions (`internal/coderterm`) cannot drive `agy` the same way. `agy acp` (JSON-RPC over stdio, with `session/request_permission`) and `--input-format stream-json` with `--conversation <id>` exist for persistent sessions; neither was tried.

## What to build

- `coder=agy` beside `codex` and `claude` in the coder tool (`agent/coder_tool.go`): run `agy -p <task> --output-format stream-json --dangerously-skip-permissions` as a one-shot CLI subtask, with a collector for its stream: progress from `step_update` (the text deltas, a line per tool step with its name and what it runs, sub-agent steps), the answer from `result.response`, the run's usage from `result.usage`, turns from `num_turns`.
- Failures said plainly in the tool result: `status` other than `SUCCESS` with its `error`; not signed in (tell the user to run `agy` once and sign in; do not wait out the sign-in prompt longer than needed); a non-empty `denied_actions` is a failed run naming the denied actions, never an empty success.
- Usage rows in `usage.db` as the other coders' (`internal/coderusage`): host `antigravity-cli`, operation and scene `coder`, model `agy`, tokens only. `InputTokens` counts cached reads as `llmstats` does (check whether agy's `input_tokens` includes `cache_read_tokens` and say which in the code); thinking tokens go where Codex's reasoning tokens go. The tool result's `usage` line and the run's last activity line as for the others.
- Quota: read with `agy -p /usage --output-format json` (after each agy run, and in `POST /stats/coder/quota/refresh`), kept in `coder_quota`, returned by `GET /stats/coder/quota`, and said in the usage line. `coderusage.Quota` gets what it lacks for this: a window belongs to a model group (name, the models in it), and used is `1 - remaining_fraction`. The Console's Coding agents dialog shows agy as a third section with a row per group and window. The note to the agent warns as for the others when a group is nearly used up.
- In the Console, `agy` runs the same one-shot way (no terminal session, so no approval prompts): the tool description and the docs say so. Codex and Claude Code keep their terminal sessions.
- Lookup and environment as the other coders', including what FT131 changes (the bash tool's environment, default install locations): add `%LOCALAPPDATA%\agy\bin` to the Windows defaults. Check that agy finds its sign-in under that environment on Linux and macOS (the keyring may need variables the allowlist lacks); if it does not, say what must be listed in `tools.bash.injected_env_vars`, or add the variable to the allowlist if it is not a secret, and record which.
- Everywhere the two coders are listed: the tool's parameter and description, worker names, the quota routes' backend list, `assets/config/config.example.yaml`, `docs/tools.md`, the English guide pages, the Console's texts and tests.

Out of scope, each its own item later: persistent agy sessions with approvals in the Console (through `agy acp`, see `wrappers/acp/`); choosing agy's model from the coder tool.

Order: FT131 (environment, default paths) is in ready and FT130 (terminal usage, daily chart) is being built; start from the base branch as it is and fit whichever of them has landed.

## Checking

- Tests with fake `agy` CLIs replaying the captured events above: a successful run with text and a tool step, the usage rows, a denied action, an `ERROR` result, not signed in, a stream line that is not JSON; the `/usage` read with two groups, with a five-hour and a weekly bucket in one group, with `remaining_fraction` 0, and when the CLI fails; the routes with three coders; the Console dialog with agy's groups.
- A real `agy` is installed and signed in on the owner's machine at `~/.local/bin/agy`. Run it once for real with `--dangerously-skip-permissions` in a throwaway folder and compare the stream with the fakes; read the real quota. Record what was not checked (Windows, macOS, a tier with five-hour buckets, sub-agent steps).
- Add `docs/feat/feat_<date>_coder_agy.md` with the sources and behaviour, as `feat_20261113_coder_usage_quota.md` does for the other two.
