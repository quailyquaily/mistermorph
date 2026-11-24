---
branch: factory/FT179-agent-config-tools
round: 1
---
# Let the agent read and change its own config through deferred tools

## factory · 2026-11-24 20:12
Owner request: “i think it would be a good idea to export tools to `tool search` to update and read the config, so the agent can update the config itself. one thing need to note, for the key or secret things, we can't export to the agent directly. for example, if the agent wanna read `llm.api_key`, should export a masked value. right?” → “ok. and in the awareness, we don't provide the tools to set config. and is there a tool to query the config structure?” → “yes, add to factory new/”

Today the config lives in agent.db (or the `--config` file) and `morph config get/set` reads and writes it (`cmd/mistermorph/configcmd/configcmd.go`), but the agent has no config tool: `tools/builtin/` and `internal/` have none. The only way in is `bash` running `morph config get`, which prints secrets in clear. There is also no way to ask what keys exist.

Add two deferred tools (behind `tool_search`, `Deferred() bool` = true), `config_get` and `config_set`.

**`config_get`** (read-only): reads values and the structure together.
- No path: the top-level sections, each with a one-line description.
- A section path (`llm`, `telegram`): the keys under it. A key path (`llm.model`): that key. Each key comes with its current value (as written, `${VAR}` and secret references not expanded), type, default, apply mode, whether it is sensitive, whether `config_set` may change it, and its doc comment.
- Structure comes from the field catalog in `internal/configsettings/fields.go` (path, kind, default, `Sensitive`, `ApplyMode`) and the comments in the embedded `assets/config/config.example.yaml` (`cmd/mistermorph/install.go:158`). Keys in the example but not in the catalog are still listed with their comment.

**Secrets are never returned.** Every `Sensitive` field (`llm.api_key`, `llm.bedrock.*` keys, `llm.cloudflare.api_token`, `console.password`/`password_hash`, `server.auth_token`, the channel bot tokens and app secrets, `x.client_secret`/`refresh_token`, …) is masked: say whether it is set, and where from (literal, `${ENV}`, secret reference), never the value or any part of it. Reading a mapping or list that contains one masks it inside (for example `config_get("llm")`, `llm.routes`). Keys under `secrets.*`, and any value that is a resolved secret, are treated the same way.

**`config_set`**: set or unset one path; the value is read as YAML, like `morph config set`.
- Requires approval every time, through the guard's forced approvals (`guard/forced.go`), showing the path, the old value and the new one (masked where sensitive). Owner only: refused in group chats and for non-owner contacts.
- Deny list, refused before approval: `guard.*`, `secrets.*`, `console.*`, `server.auth_token`, `llm.endpoint` (and per-route endpoints), MCP server definitions, and the bootstrap keys `configstore.CheckBootstrapKeys` already refuses.
- Sensitive fields: the value is stored through `configsettings.ProtectSecrets` (secret reference in the OS store), not in plain text in the config. The mask string that `config_get` returns is rejected as a value, so a read-then-write cannot overwrite a secret with its mask.
- Validates against the field catalog (kind, enums) before writing; writes with a new `configstore` author (for example `ByAgent`) so `configrevision` history shows the agent made the change.
- Applies like a Console settings change: `managed.ReloadConfig` where the runtime has it, and returns the field's apply mode (next generation, runtime restart, process restart) so the agent can tell the user what is still needed.

**Awareness gets no `config_set`.** Heartbeat and scheduled-job runs have nobody to approve a change. Register `config_set` only in the chat/task registries, not the awareness ones (`cmd/mistermorph/root.go:606`, the console's `buildConsoleRegistriesFromReader` in `consolecmd/local_runtime.go:809`, and `buildAwarenessRegistry` in `integration/registry.go`). `config_get` is fine there, as it only reads and masks.

Acceptance criteria:
- `tool_search` finds both tools; neither is in the prompt's tool list until found.
- `config_get` with no path, a section path, and a key path returns the structure described above, with comments from `config.example.yaml`.
- No output of `config_get` contains a secret value, for every `Sensitive` field, set as a literal, `${ENV}` or secret reference, read directly or through a parent mapping or list. A test walks every `Sensitive` field.
- `config_set` asks for approval each time; a denied approval changes nothing. Deny-listed paths and the mask string are refused. Sensitive values end up as secret references.
- `config_set` is absent from every awareness registry (test), and refused for non-owners.
- A change shows in `morph config get` and in the config revision history with the agent as author, and the result states the apply mode.
- `assets/config/config.example.yaml` documents anything new (for example a switch to turn the tools off).

## factory · plan · 2026-11-24 20:49
Behaviour:
- Discover config_get/config_set only through tool_search. Read persisted YAML without resolving env or secret references. Empty path lists documented sections; section/key reads expose catalog metadata and embedded-example comments, including undocumented-in-catalog example keys.
- Recursively redact sensitive paths (including nested routes, secrets, arbitrary secret references) into non-reversible set/source metadata. Never expose secret identifiers, environment values, resolved secrets, raw input errors or sensitive approval payloads.
- Authorize config_set for positively established owners in private chat/task contexts, failing closed otherwise. Validate path, YAML and catalog constraints and deny forbidden descendants/ancestor replacement attacks before approval; require approval every invocation with safe old/new preview. Protect secrets, persist as ByAgent and reload managed config when available; return apply mode. Refused/denied writes leave config unchanged.
- Awareness registries contain only the read tool, never the setter. First-run absent config gives documented unset/default entries. Store/reload failures produce safe actionable errors.
Scope:
- Shared config tooling/service, catalog/comment discovery, guard approval integration, runtime registry wiring and owner identity propagation; tests and English docs/example only as needed. No UI work; do not change current CLI's raw-get behavior, unrelated features, workflows or live config.
Decisions:
- Prefer existing configstore/configsettings/secref APIs and registry dependency injection over parallel config parsers/storage. No optional switch unless existing patterns warrant one.
- Reject unknown/noncatalog writable fields and unsafe compound values rather than guessing. Fail closed if owner or approval context cannot be proven. Never use model-supplied ownership flags.
- Redaction is recursive and conservative; preserve raw nonsecret ${VAR} values but expose only source category for secrets.
Checking:
- Exhaustive Sensitive catalog walk for literal/env/secret-reference direct and parent reads; nested route/list secrets, aliases, unset/empty first run and error leakage.
- Guard forced approval every call including disabled guard, owner/group/unknown identity refusal, denylists and ancestor replacement, mask roundtrip, kind/enums, approve/deny atomicity, OS secret refs, author history, apply modes/reload.
- Registry/deferred discovery and absence of config_set from every awareness construction path.
- Mandatory gofmt, go vet ./..., go test ./... in isolated test HOME. No UI expected; live provider/chat and OS-keychain integration may remain untested and must be noted.

## factory · 2026-11-24 20:49
Built deferred config_get/config_set with catalog and embedded-example comments, recursive secret masking, private owner-only setters, forced safe approval previews, OS-store protection, agent-authored revisions and Console reload wiring. Awareness excludes config_set at registration and run time. Added tool enable switches, docs and regression tests.

head: 50247f4f
round: 1
Decisions: fail closed on absent owner/approval/keyring context; reject noncatalog writes, mask strings and environment references; conservatively deny credential headers, owner/admin changes, endpoints and approval bypass settings in addition to the requested denylist. Deferred tools require tool_search enabled. Embedding users must supply an explicit config path.
Installs: none.
Verification: manager reran the complete required gate after the final commit under an isolated HOME: gofmt clean; go vet ./... passed; go test ./... passed (exit 0). No restricted paths changed; only this item's commit is present.
Not checked: live model/channel approval flows, real OS keyring, and live running Console reload (wiring covered by tests). LINE/Lark approval UI availability remains unverified. No Console frontend changed.
Push: initial credential-helper invocation lacked repository path; command-local credential.useHttpPath=true resolved it on the single retry. Code branch pushed successfully.
Move: new/ → review/. Review should inspect the conservative denylist, owner identity and approval resume handling, secret redaction/storage, and runtime registration coverage.

## factory · review · 2026-11-24 21:00
head: 50247f4f57865697236f0e32068e35d355840682
verdict: pass
notes:
- Claude Code reviewed all 37 changed files against origin/master (7c405d1b), the item request and plan, using the review-code skill and security-review reference. No qualifying findings; no code changes or commits.
- Required gate passed in isolated HOME/XDG/GOCACHE with offline read-only module cache: gofmt clean; go vet ./... clean; go test ./... exit 0 (169 packages ok).
- Temporary isolated probes passed for recursive masking and aliases, tool_search/forced-approval/resume with in-memory keyring, owner and denylist enforcement, mask rejection, and first-run file/database storage. Branch merges cleanly with base.
- Residual risks: nonsecret config_get values are readable to all audiences; unrecognised credentials embedded in MCP args, URLs or unusual keys are not guaranteed masked. Secret setter arguments remain in pending approval storage, though approval presentation/log output is masked. Command-line overrides still take precedence over persisted settings.
- Not checked: live channel approval UI (including LINE/Lark), real OS keyring, live Console runtime reload. No frontend changed. Installs: none. Runtime-owned temporary output was observed outside the run directory and recorded for owner-confirmed cleanup.
- Move: review/ → ready/.


## factory · 2026-11-25 07:20
Merged into master at a22996fa4fcd1fc4baf21cec565e473f09579de9; released in v0.3.133.
Validation: per-item Go gate passed; final gofmt check, go vet ./... and go test ./... passed. Final nsh check and full Console runner passed: 165 files, 0 failed (581s).
Linked issues/PRs: none. Branch retained (ship clean not configured). No installs or code fixes. Existing review notes remain applicable; in particular FT182 Agent Link file delivery and FT183 PDF preview limitations were not fixed or live-tested.
Move: ready/ → done/.
