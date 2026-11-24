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
