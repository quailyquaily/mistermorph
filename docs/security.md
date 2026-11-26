---
title: Security
---

# Security

This document focuses on:

- **process isolation** and **filesystem sandboxing** for long-lived runtime processes such as `morph telegram`, `morph slack`, `morph line`, `morph lark`, or `morph console serve`
- **secret handling** for authenticated outbound HTTP calls (profile-based credential injection)
- **Guard (M1)**: outbound allowlists, redaction, async approvals, and audit logs

## Table of contents

- [Threat model](#threat-model)
- [Guard (M1)](#guard-m1)
  - [Outbound allowlists](#outbound-allowlists)
  - [Redaction](#redaction)
  - [Async approvals and audit](#async-approvals-and-audit)
- [Secret handling (profile-based auth)](#secret-handling-profile-based-auth)
  - [Configure profiles](#configure-profiles)
  - [Tool behavior and safeguards](#tool-behavior-and-safeguards)
- [Systemd sandbox](#systemd-sandbox)
  - [Recommended deployment layout](#recommended-deployment-layout)
  - [Filesystem sandboxing](#filesystem-sandboxing)
  - [Other hardening knobs](#other-hardening-knobs)
- [Notes and limitations](#notes-and-limitations)

## Threat model

`mistermorph` is an agent that can:

- make outbound HTTP(S) calls (LLM provider, web_search, url_fetch, Telegram)
- read local files (read_file tool, skill discovery)
- optionally execute shell commands (bash tool, if enabled)

The main security risks are:

- **data exfiltration** (sending local data to external services)
- **secret leakage** (prompts, tool params, logs, traces)
- **over-broad capabilities** (shell access, unrestricted networking, unrestricted filesystem reads/writes)

## Guard (M1)

Guard is a lightweight, content/workflow safety layer designed to complement (not replace) OS/container sandboxing.

M1 focuses on three high-value capabilities:

- outbound destination allowlists (primarily `url_fetch`)
- redaction for tool outputs, final outputs, and audit summaries
- async approvals and an audit trail (JSONL)

### Outbound allowlists

Guard can enforce a **global allowlist** for unauthenticated `url_fetch` calls (i.e. calls without `auth_profile`).

Config (example):

```yaml
guard:
  enabled: true
  network:
    url_fetch:
      allowed_url_prefixes:
        - "https://api.example.com/v1/"
      deny_private_ips: true
      allow_proxy: false
      follow_redirects: false
```

Behavior:

- If `guard.network.url_fetch.allowed_url_prefixes` is **empty**, unauthenticated `url_fetch` is **blocked** (fail-closed).
- If `url_fetch` uses `auth_profile`, the destination boundary is enforced by `auth_profiles.<id>.allow.url_prefixes` (Guard still audits, but does not add an extra global allowlist layer by default).

Hardening toggles:

- `deny_private_ips`: blocks literal `localhost` / `127.0.0.1` / RFC1918 private IP targets to reduce SSRF risk. M1 does not resolve hostnames to IPs; enforce egress at the network/OS layer if you need stronger guarantees.
- `allow_proxy`: when false, the HTTP client ignores `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` to avoid unexpected routing/MITM.

#### `url_fetch` when the desktop app requires a network proxy

While the desktop app runs an explicit network proxy, it starts the backend with the proxy variables and the marker `MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1`. The marker changes how `url_fetch` picks its route. It does not change, read past or relax any guard or auth profile setting; without it `url_fetch` behaves exactly as described above.

With the marker, for every request and every redirect hop to a destination that is not loopback:

- The route is the proxy or nothing: `url_fetch` never removes the proxy and never dials the destination itself.
- `allow_proxy` is honored: when the guard is on and `guard.network.url_fetch.allow_proxy` is false, or the request uses an auth profile whose `allow_proxy` is false, the request is refused before anything is sent.
- `deny_private_ips` is honored: when it is true and the destination is a host name, the request is refused. The proxy would resolve the name, so the resolved address cannot be checked, and the name is not resolved locally to get around that. An IP literal is checked as before and, if allowed, sent through the proxy.
- Everything else stays: allowed URL prefixes, the literal `localhost` and private-address checks, redirect rules and auth profile URL rules, on the first request and on every hop.

`allow_proxy: false` and `deny_private_ips: true` are the defaults, so under the default guard settings `url_fetch` is refused for every host name while an explicit proxy is running. Nothing sets these automatically. An owner who wants `url_fetch` to reach host names through the proxy sets, by hand:

```yaml
guard:
  network:
    url_fetch:
      allow_proxy: true
      deny_private_ips: false
```

and, for requests with an auth profile, that profile's `allow.allow_proxy: true`.

What turning `deny_private_ips` off gives up: the check that a URL does not name `localhost` or a private address, and the check that a host name does not resolve to one. Through a proxy the second check cannot be made at all, because the proxy resolves the name: a host name that points at an address inside the proxy's network is reachable for `url_fetch` if the proxy lets it through. Keep `allowed_url_prefixes` narrow, and restrict what the proxy itself may reach, if that matters.

Other boundaries of the desktop proxy:

- With a proxy password, the backend's environment contains the proxy URL with that password. Other processes of the same user can read it, and MCP stdio servers, which are started with the backend's whole environment, receive it.
- The bash and PowerShell tools and the coder CLIs get neither the proxy variables nor the marker unless the owner lists a name in `tools.bash.injected_env_vars` / `tools.powershell.injected_env_vars`; listing them passes the password too.
- The desktop log is filtered for the known forms of the proxy password. That filter is a second line of defense; it does not make arbitrary backend output safe.

### Redaction

Guard redacts secret-like content **before it enters context/logs**:

- tool observations (`ToolCallPost`)
- final output (`OutputPublish`)
- redacted audit summaries for selected actions (`read_file` path, `web_search` query, `url_fetch` URL, `bash` command, and `OutputPublish`)

ASCII flow:

```text
                      +----------------------+
                      |   tool pre summary   |
                      | read_file/web_search |
                      | url_fetch/bash params|
                      +----------+-----------+
                                 |
                                 v
                      +----------------------+
                      | redactAuditValue(...)|
                      +----------+-----------+
                                 |
                                 v
                            audit JSONL


tool output / final output
          |
          v
  +----------------------+
  | Guard Redactor       |
  | - private keys       |
  | - JWT-like strings   |
  | - Bearer tokens      |
  | - sensitive key=value|
  | - MISTER_MORPH_* env |
  +----------+-----------+
             |
             v
   allow_with_redaction + redacted content
             |
             +--> model context / final publish / audit
```

Built-in redactors cover common patterns:

- private key blocks
- JWT-like strings
- bearer tokens
- sensitive `key=value` forms
- `MISTER_MORPH_*` environment variable names and assignments

For `MISTER_MORPH_*`, Guard redacts both the variable name and its value. For example:

```text
MISTER_MORPH_API_KEY=...
```

becomes:

```text
[redacted_env]=[redacted]
```

You can add extra regex patterns under `guard.redaction.patterns`.

### Async approvals and audit

Guard approvals are asynchronous by design:

- When an action requires approval (M1 default: `bash` tool when enabled), the run pauses and returns a `final.output` object like:
  - `{ "status": "pending", "approval_request_id": "apr_...", "message": "..." }`
- Approval state is stored in file state (`<file_state_dir>/<guard.dir_name>/approvals/guard_approvals.json` by default).
- Approval expiry is **hard-coded to 5 minutes** in M1.

Long-running modes that start the embedded admin server expose management endpoints under the standard `/runtime` API base, authenticated with `server.auth_token`. The paths below are relative to that base:

- `GET /approvals/{id}` (status + metadata; never returns `resume_state`)
- `POST /approvals/{id}/approve`
- `POST /approvals/{id}/deny`
- `POST /approvals/{id}/resume` (re-queues the paused task)
- `POST /poke`
  - creates one awareness task from the textual request body
  - returns `400 Bad Request` when the body is empty or non-text
  - returns `413 Request Entity Too Large` when the body exceeds 10 KB
  - returns `409 Conflict` if an awareness task is already in progress
- `POST /poke/{job_id}`
  - queues one run of a job that has a `poke` trigger; the body is optional, under the same 10 KB limit
  - the body reaches the run as quoted, untrusted data in a block of its own that names the job and its poke trigger, never as part of the job's instructions
  - returns `404 Not Found` for an unknown job, and `409 Conflict` when the job has no poke trigger, is switched off, or is already queued or running
- `GET /settings/agent`
- `PUT /settings/agent`
- `POST /settings/agent/models`
- `POST /settings/agent/test`
- `GET /auth/codex/status`
- `POST /auth/codex/refresh`
- `POST /auth/codex/login/start`
- `POST /auth/codex/login/poll`
- `POST /auth/codex/logout`

The Codex OAuth API never returns token values. Login sessions are process-local, short-lived, and bound to the runtime that created them.

Audit:

- Guard emits structured audit events to an append-only JSONL log.
- Configure via `guard.audit.jsonl_path` (default: `<file_state_dir>/<guard.dir_name>/audit/guard_audit.jsonl`) and `guard.audit.rotate_max_bytes`.

Task data retention:

- Accepted task and topic changes are written to `<file_state_dir>/journal/`, including task text and available conversation participant identifiers and nicknames.
- `tasks.persistence_targets` controls task projection recovery. It does not disable journal records for targets omitted from the list.

## Systemd sandbox

Because of those capabilities, long-lived runtime processes are a good candidate for a **deny-by-default** runtime profile:

- keep the root filesystem read-only
- allow writes only to explicitly declared directories
- reduce kernel / device / namespace surface
- run without elevated privileges

systemd provides a first-class “service hardening” feature set for this. Unlike `chroot`, it does not require building a separate root filesystem; it applies restrictions directly to the unit.

### Recommended deployment layout

The recommended unit assumes:

- Binary: `/opt/morph/mistermorph`
- Config: `/opt/morph/config.yaml`
- Skills: `/opt/morph/skills` (set `file_state_dir: /opt/morph` and `skills.dir_name: skills`)
- Persistent state (guard approvals, tasks, contacts, etc.): `/var/lib/morph/`
- Ephemeral cache (file_cache_dir, Telegram downloads): `/var/cache/morph/`
- write_file tool output: `/var/cache/morph/` or `/var/lib/morph/` (file_cache_dir or file_state_dir)
- Non-secret env/config: `/opt/morph/morph.env` (mode `0640`, owned by root or `morph`)
- Secrets env: `/opt/morph/morph.secrets.env` (mode `0600`, owned by root or `morph`)

See the example unit file: `deploy/systemd/mister-morph.service`.

## Secret handling (profile-based auth)

Agents are extremely good at “accidentally” leaking secrets if you ever put them into:

- prompts / skill docs
- tool parameters (especially headers)
- logs / traces

To avoid this, `mistermorph` supports **profile-based credential injection**:

- Skills/LLM only reference a profile id (e.g. `auth_profile: "jsonbill"`).
- The host resolves the real secret value at config load time. Use `${ENV_VAR}` syntax in `credential.secret` to reference environment variables.
- The tool injects the credential into the actual HTTP request (e.g. `Authorization: Bearer …`) without logging it.

### Configure profiles

In `/opt/morph/config.yaml`:

```yaml
secrets:
  allow_profiles: ["jsonbill"]

auth_profiles:
  jsonbill:
    credential:
      kind: api_key
      secret: "${JSONBILL_API_KEY}"
    allow:
      url_prefixes: ["https://api.jsonbill.com/tasks"]
      methods: ["POST", "GET"]
      follow_redirects: false
      allow_proxy: false
      deny_private_ips: true
    bindings:
      url_fetch:
        inject:
          location: header
          name: Authorization
          format: bearer
        allow_user_headers: true
        user_header_allowlist: ["Accept", "Content-Type", "User-Agent"]
```

In `/opt/morph/morph.secrets.env`:

```bash
JSONBILL_API_KEY="..."
MISTER_MORPH_LLM_API_KEY="..."
MISTER_MORPH_SERVER_AUTH_TOKEN="..."
```

### Tool behavior and safeguards

- `url_fetch` supports `auth_profile` and injects credentials server-side.
- `url_fetch` rejects sensitive headers in user-provided `headers` to reduce accidental leaks.
- `url_fetch` supports saving binary responses to `file_cache_dir` (instead of inlining bytes in the LLM context), which is recommended for PDFs.
- When at least one allowlisted auth profile is configured, `bash` can still be enabled for local automation, but `curl` is rejected by default to avoid “bash + curl” carrying authenticated HTTP requests.
- `bash` does not inherit the full parent environment. It runs with a small built-in allowlist (`PATH`, locale, shell/home, temp, XDG, and SSL cert vars) so `MISTER_MORPH_*` secrets are not exposed to subprocesses by default.
- If a local workflow needs extra variables, inject them explicitly with `tools.bash.injected_env_vars`.
- A command marked `elevated` runs as root or administrator only after the user approves it, with
  the command shown: on an approval card in the chat that started the task, or in a system dialog
  (`sudo -k -A` with mistermorph as the askpass helper on Linux and macOS, UAC on Windows). Each
  command needs its own approval. The password goes to sudo; the agent process holds it only to
  pass it on, and the model, tool output and logs never see it. The agent hands it only to sudo's
  own askpass helper (a direct child of that sudo, checked through the socket's peer credentials),
  not to another process of the user that read the helper's token. From the web Console and remote
  chat it travels over the client's connection, protected by that alone: reach the Console over
  HTTPS, an SSH tunnel or a VPN such as WireGuard. On plain HTTP to another machine the web Console
  shows a warning across the top; the runtime cannot tell, as a TLS proxy or a VPN looks like plain HTTP to it. Each
  elevated command and each answer is logged (`elevated_command_started`,
  `elevated_command_finished`, `elevated_command_approved`, `elevated_command_declined`,
  `elevated_command_answer_rejected`). Turn it off with `tools.bash.elevation.enabled: false` (or the
  `powershell` one); keep it off for
  services nobody watches. See [Elevated commands](tools.md#elevated-commands).

### Filesystem sandboxing

#### Read-only system files

- `ProtectSystem=strict` makes the system directories effectively read-only for the service (with a small set of unavoidable exceptions handled by systemd).
- This prevents accidental or malicious writes to places like `/etc`, `/usr`, `/bin`, etc.

#### No access to home directories

- `ProtectHome=true` hides `/home`, `/root`, and `/run/user` from the service.
- This is a strong default: it prevents the agent from reading shell history, SSH keys, dotfiles, and other sensitive user data.

If you need access to specific content, prefer moving it under `/opt/morph/...` or using explicit bind mounts (see below) rather than opening up all of `/home`.

#### Explicit writable directories only

systemd can create and manage service-owned directories under `/var/lib`, `/var/cache`, and `/var/log`:

- `StateDirectory=morph` → writable `/var/lib/morph` (persistent state)
- `CacheDirectory=morph` → writable `/var/cache/morph` (ephemeral cache)

For `mistermorph`, this split is recommended because guard approvals and other state are persistent and should not be treated as disposable.

The example unit additionally pins the agent’s paths via env vars:

- `MISTER_MORPH_FILE_CACHE_DIR=/var/cache/morph`

`WorkingDirectory` is not a workspace setting. For a writable default project directory, set `MISTER_MORPH_WORKSPACE_DIR` and allow that directory explicitly:

- `Environment=MISTER_MORPH_WORKSPACE_DIR=/srv/morph-workspace`
- `ReadWritePaths=/srv/morph-workspace`

#### Optional bind mounts (fine-grained allowlist)

If you want the agent to read a specific project directory, allowlist it explicitly:

- Read-only: `BindReadOnlyPaths=/some/dir:/workspace/dir`
- Read-write: `BindPaths=/some/dir:/workspace/dir`

Prefer bind mounts over weakening `ProtectSystem`/`ProtectHome`.

### Other hardening knobs

The example unit also enables common isolation options:

- `NoNewPrivileges=true`: prevents gaining extra privileges (e.g. via setuid binaries).
- `PrivateTmp=true`: private `/tmp` for the service.
- `PrivateDevices=true` + `DevicePolicy=closed`: blocks access to device nodes.
- `ProtectProc=invisible` + `ProcSubset=pid`: reduce process info leakage.
- `RestrictNamespaces=true`: reduces attack surface from namespace creation.
- `MemoryDenyWriteExecute=true`: blocks W+X memory mappings (mitigates some exploit classes).
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`: allow only typical networking families (needed for outbound HTTP(S) and local sockets).

## Jobs: inputs, message triggers and references

- A job's `uses` give its runs the used jobs' definitions and results through the job-reference machinery (`internal/jobrefs`), with its rules unchanged: the data is one JSON block marked read-only source data; a job's `bash_env` values, workspace, model profile and delivery target are never part of it; instructions and outputs are cut to the reference limits; a job that reports to a chat may read only jobs that report to that same chat, and a used job it may not read fails the run with the refusal an unknown job gets. Links inside a used job's text are not followed.
- A use starts the job that has it, never the used job: each `done` run of the used job queues the dependent, which runs with its own settings (its `bash_env`, workspace and profile), exactly as its schedule would run it, and only when it is switched on; a chain of such runs is at most 5 jobs deep. A `[label](job:<id>)` link in a job's text reads and starts nothing.
- A `message` trigger lets a chat start a job: anyone who can post in that chat can cause a run, at most one per trigger per 60 seconds. The message never becomes instructions: it is given to the run as JSON (sender, time, text; the text cut at 4000 characters) quoted in a block of its own that says it is untrusted source data, beside the job's unchanged instructions. The job runs with the job's own tools and settings, not the sender's; the sender is not checked against the channel's allowlist or group-trigger rules, since the owner named the chat in the trigger. Give a job that a chat can start only the tools and `bash_env` that chat should be able to exercise.
- The agent's own messages never start a job, so a job that reports to the chat it watches does not start itself. Another bot's message does start it; two bots that answer each other are held to the one run per minute. An Agent Link answer to a message this agent sent starts no job.
- A Console task started by an Agent Link late answer carries text the remote agent wrote. It asks for job references as no one: a `[label](job:<id>)` in it fails that task with the refusal an unknown job gets, and no job is read.
- A job reference in the data a run is started with is read, and never starts the referenced job. `POST /poke` and `POST /poke/{job_id}` take the runtime's auth token: the body of the first asks as the owner, the body of the second as the poked job (a job that reports to a chat reads only that chat's jobs). A message that fires a `message` trigger is written by whoever can post in the chat, so a reference in it reaches only jobs that report to that same chat, and only if the started job may read them too; any other reference fails that run with the refusal an unknown job gets, which lets a member of the chat fail a run on purpose (at most one per trigger per minute).
- A Console message that references a job while a run is in progress in its topic is refused (`400`), not handed to the run: the run would take the link as text and no access check would be made. It is accepted once the run has ended.

## Notes and limitations

- systemd hardening is not a perfect sandbox. If you need stronger isolation, consider running in a container/VM.
- If you enable the `bash` tool, treat it as high risk. Prefer keeping it disabled in long-lived runtime processes, or requiring confirmations and using a strict allowlist of read-only bind mounts.
- Even with profile-based auth, avoid enabling arbitrary outbound execution paths (e.g. shelling out to network tools). Prefer structured tools with explicit allowlists and fail-closed policy.
- Guard M1 is intentionally small: Telegram approval UX and durable task storage across daemon restarts are not implemented yet.
