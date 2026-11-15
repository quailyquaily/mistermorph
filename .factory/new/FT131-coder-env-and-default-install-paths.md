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
