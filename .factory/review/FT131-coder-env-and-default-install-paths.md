---
branch: factory/FT131-coder-env-and-default-install-paths
round: 1
---
# Coder runs in the bash tool's environment and finds the CLIs' default install locations

## factory · 2026-11-15 20:23
Recorded from the owner's request to put this in new.

Owner request:
> 1. the coder tool should inherit the path of bash tool, aka, the same limited env, ( console and terminal also has the TERM set to xterm-256color)
> 2. the coder tool will append the default install locations to PATH if tools.coder.path_extra is empty.

Today:
- The bash tool runs commands in a limited environment (`bashToolEnvWithPathExtra` in `tools/builtin/bash.go`): `PATH` with `tools.bash.path_extra` in front, an allowlist of variables (`HOME`, `LANG`, `TERM`, `USER`, `SHELL`, the `XDG_*` dirs, the SSL cert variables and the rest of that list), and `tools.bash.injected_env_vars`.
- The coder tool starts `codex` / `claude` with the runtime's whole environment (`prepareCoderCommand` in `agent/coder_tool.go`: inherited untouched without `tools.coder.path_extra`, else only `PATH` replaced; `internal/coderterm/session_unix.go` does the same and sets `TERM=xterm-256color`). So every secret in the service's environment reaches the CLI and the commands it runs, and a tool reachable only through `tools.bash.path_extra` is missing inside a coder run.
- A runtime started with a short PATH (a service manager's) does not find the CLIs unless `tools.coder.path_extra` is set, although both installers use a known location.

Requirements and acceptance criteria:

Part 1, the coder's environment:
- A coder run, headless and in a Console terminal session, gets the environment the bash tool gives a command: the same allowlist, the same `tools.bash.injected_env_vars`, and the bash tool's `PATH` (`tools.bash.path_extra` included). Nothing else from the runtime's environment reaches the CLI. Build it with the bash tool's own code, not a copy of the list, so the two cannot drift.
- Console terminal sessions keep `TERM=xterm-256color`, as now.
- `tools.coder.path_extra` stays: its directories go in front of that `PATH`, for the coder only.
- The same environment and lookup apply wherever the runtime starts the CLIs for itself: the quota reads (`coderusage.FindCommand`, `ReadCodexQuota`, `ReadClaudeQuota`, the `/stats/coder/quota` routes).
- Check what the CLIs lose and say it in the docs: proxy variables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, provider keys and the like no longer pass unless listed in `tools.bash.injected_env_vars`. Check that both CLIs still start, sign in with the subscription, and that the terminal session still finds their session files (it reads `CODEX_HOME` and Claude's config dir from the environment it was given). On Windows the coder runs headless; keep what the CLIs need there (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `PATHEXT`), as the PowerShell tool's environment does or by adding to it, and record what was done.

Part 2, default install locations:
- When `tools.coder.path_extra` is empty, the coder appends the default install locations of Codex and Claude Code to the end of its `PATH`, so they never replace a CLI the PATH already finds. Only directories that exist are added, and none twice.
- The list (from the installers themselves, `https://claude.ai/install.sh`, `https://chatgpt.com/codex/install.sh` and their `.ps1`, checked 2026-11-15):
  - `~/.local/bin`: both installers on macOS and Linux (`claude` links into `~/.local/share/claude/versions/`, `codex` into `~/.codex/packages/standalone/current/bin/`).
  - `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`: Homebrew's prefixes.
  - Windows: `%USERPROFILE%\.local\bin` (Claude Code) and `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (Codex).
- npm global installs under a version manager have no fixed path and stay the user's to add in `tools.coder.path_extra`.
- With `tools.coder.path_extra` set, nothing is appended.

Docs and config:
- `assets/config/config.example.yaml` (`tools.coder.path_extra`, `tools.bash.path_extra`, `tools.bash.injected_env_vars`), `docs/tools.md`, and the English guide pages that describe the coder's PATH (`web/vitepress/docs/guide/subagents.md`, `built-in-tools.md`).

Checking:
- Tests: the coder's environment equals the bash tool's for the same settings (a secret set in the test's environment does not reach a fake CLI; an injected variable and a `tools.bash.path_extra` directory do); `TERM` in a terminal session; the order of `PATH`; defaults appended only when `tools.coder.path_extra` is empty, only existing directories, after PATH, not twice; the quota lookup finds a CLI in a default directory. Tests must not find the machine's real `codex` / `claude`: give the default list and the home directory to the code under test.
- Run both CLIs for real once, headless and in a Console terminal session, from a runtime started with a short PATH and a secret in its environment; record what was not checked.

## factory · 2026-11-15 20:25
Clarifications, agreed with the owner. Where they differ from the section above, these hold.

- PATH order, in one line: `tools.coder.path_extra`, then `tools.bash.path_extra`, then the runtime's PATH (the bash tool's fallback when it is empty), then, only when `tools.coder.path_extra` is empty, the default install locations that exist and are not already listed.
- Windows: the coder gets the PowerShell tool's environment (`powershellToolEnv` in `tools/builtin/powershell.go`, which already carries `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PATHEXT` and the rest), with the PATH above. No choice to make there.
- Strict, no pass-through: nothing outside the allowlist and `tools.bash.injected_env_vars` reaches the CLIs, proxy variables included. A setup that relied on a variable from the service's environment (a proxy, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, a provider key for API billing) stops working until it is listed in `tools.bash.injected_env_vars`. This is intended: secrets stop reaching the CLIs. Say so in the docs with the variables to list, and put a `Breaking:` line in the build report so the ship run carries it into the release.
- Reusing the bash tool's code: the environment builders are private to `tools/builtin`, which `agent` does not import, and the coder is given only `CoderPathExtra` today. Move the builders somewhere both can import (`internal/shellenv` already has the injected variables) or hand the coder a ready environment builder through `EngineToolsConfig`, and pass the bash tool's `path_extra` and injected variables to every place that fills `CoderPathExtra` (`channelruntime/core`, `channelopts`, `consolecmd`, `chatcmd`, `runcmd`, `integration`). Do not copy the allowlist. Injected variables must resolve for the coder as they do for a bash command at that moment.

## factory · plan · 2026-11-15 20:54

Behaviour: Build each coder environment at invocation time using shared bash/PowerShell environment builders and dynamically resolved injected variables. Permit no other service variables. Terminal keeps TERM=xterm-256color. PATH order is coder extras, bash extras, runtime PATH (bash fallback when empty), and only with empty coder extras, existing unique default install directories. Apply the same lookup/environment to headless, Console terminal and quota reads. Missing commands fail normally without unrestricted-environment fallback.
Scope: Shared environment builders and lookup, wiring through engine/runtime/channel/CLI/integration/quota routes, deterministic regression tests, English docs and config example. No workflows, secrets, user configuration, deployment or unrelated UI changes.
Decisions: Prefer internal/shellenv shared code; no copied allowlists. Preserve bash and PowerShell semantics; explicit coder extras suppress automatic defaults. Inject home/default directories for tests. Environment restriction is intentionally breaking: document proxy/config-directory/provider-key injections. Real CLI probes must be non-destructive, must not initiate login or change settings; report unavailable authenticated checks explicitly.
Checking: Cover secret exclusion, dynamic injection, bash parity, path precedence/fallback/default dedup/existence/suppression, quota discovery, terminal TERM/session-file environment, Windows environment/build. Required check: test -z "$(gofmt -l .)" && go vet ./... && go test ./... with absolute throwaway HOME. If Console sources change, nsh check and web/console-nsh/scripts/test.sh. Attempt safe real CLI startup/subscription/terminal probes under short PATH with sentinel secret; state exactly what could not be verified.

## factory · 2026-11-15 20:54
Built and pushed c5b437ec on factory/FT131-coder-env-and-default-install-paths. Moved new/ → review/ (round 1).

Shared shellenv builders now provide the bash/PowerShell allowlist for headless coder runs, terminal sessions and quota reads. Runtime/channel/CLI/integration/subtask settings are wired through; injected variables resolve at invocation time. PATH order is coder extras, bash extras, runtime/fallback, then existing unique default directories only with no coder extras. Terminal retains TERM=xterm-256color. Updated English docs and config example; added deterministic regression tests.

Breaking: Codex and Claude Code no longer inherit arbitrary service environment variables. Proxy variables, CODEX_HOME, CLAUDE_CONFIG_DIR and provider keys must be explicitly listed in tools.bash.injected_env_vars (tools.powershell.injected_env_vars on Windows). Existing subscription credentials in the normal home directory continue to work.

Decisions: Windows uses the PowerShell environment and injection settings; missing commands never fall back to unrestricted service environment. Quota lookup now follows the same precedence. EngineToolsConfig.CoderPathExtra is replaced by CoderEnv; reader interfaces now expose Get(string) any.

Installs: none; no manifest or lockfile changes.
Tests: manager independently verified test -z "$(gofmt -l .)" && go vet ./... && go test ./... with an absolute throwaway HOME; all passed. Coder reports Windows/macOS cross-builds passed, and real Codex/Claude headless and terminal probes under short PATH excluded a sentinel secret, retained terminal TERM and found session files; both subscription quota reads succeeded.

Not checked: real Windows execution; Console UI or quota routes in a running mistermorph binary; full LLM-agent end-to-end coder invocation; real proxy/custom CODEX_HOME/CLAUDE_CONFIG_DIR/API-key billing setups. Routes and environment overrides have deterministic test coverage. Console source UI unchanged; no UI inspection, nsh check or Console test run performed.

Push recovery: initial credential lookup lacked a repository path; retried successfully with per-command credential.useHttpPath=true and gh credential helper. No credential configuration or user settings changed.
