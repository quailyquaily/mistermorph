# Tools Reference

This document describes the built-in and runtime-injected tool parameters currently implemented in the codebase (based on `tools/builtin/*.go`, `cmd/mistermorph/telegramcmd/*.go`, and registration logic).

## Registration and Availability

- Default registration (controlled by `cmd/mistermorph/registry.go`)
  - `read_file`
  - `write_file`
  - `bash`
  - `url_fetch`
  - `web_search`
  - `todo_update`
  - `contacts_send`
- Conditional registration
  - `plan_create` (injected in `run` / `telegram` / `daemon serve` via `internal/toolsutil.RegisterPlanTool`; can be disabled with `tools.plan_create.enabled`)
  - `telegram_send_voice` (injected only at `mistermorph telegram` runtime)
  - `telegram_send_file` (injected only at `mistermorph telegram` runtime)
  - `telegram_react` (injected only at `mistermorph telegram` runtime)

## `read_file`

Purpose: read local text file content (very long output may be truncated).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | File path. Supports `file_cache_dir/<path>` and `file_state_dir/<path>` aliases. |

Constraints:

- Access can be blocked by `tools.read_file.deny_paths`.
- Alias paths must include a relative file path; passing only `file_cache_dir` or `file_state_dir` is invalid.

## `write_file`

Purpose: write local files (overwrite or append).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | Target path. Relative paths are written under `file_cache_dir` by default. Supports `file_state_dir/<path>`. |
| `content` | `string` | Yes | None | Text content to write. |
| `mode` | `string` | No | `overwrite` | `overwrite` or `append`. |

Constraints:

- Parent directories are created automatically when needed.
- Writes are allowed only under `file_cache_dir` / `file_state_dir`.
- Content size is limited by `tools.write_file.max_bytes`.

## `bash`

Purpose: execute local `bash` commands.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `cmd` | `string` | Yes | None | Bash command to execute. Supports `file_cache_dir/...` and `file_state_dir/...` aliases. |
| `cwd` | `string` | No | Current directory | Working directory for command execution. Supports `file_cache_dir/...` and `file_state_dir/...` aliases. |
| `timeout_seconds` | `number` | No | `tools.bash.timeout` | Timeout override in seconds. |

Constraints:

- Can be disabled via `tools.bash.enabled`.
- Restricted by `tools.bash.deny_paths` and internal deny-token rules.

## `url_fetch`

Purpose: make HTTP(S) requests and return responses (or download to file).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | Yes | None | Request URL. Only `http/https` are supported. |
| `method` | `string` | No | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE`. |
| `auth_profile` | `string` | No | None | Auth profile ID (available when secrets are enabled). |
| `headers` | `object<string,string>` | No | None | Custom headers (allowlist/denylist applies). |
| `body` | `string|object|array|number|boolean|null` | No | None | Request body (for `POST/PUT/PATCH` only). |
| `download_path` | `string` | No | None | Save response body to a cache-directory path. |
| `timeout_seconds` | `number` | No | `tools.url_fetch.timeout` | Timeout override in seconds. |
| `max_bytes` | `integer` | No | `tools.url_fetch.max_bytes` or download cap | Maximum bytes to read. |

Constraints:

- Parent directories for `download_path` are created automatically.
- With `download_path`, the tool returns download metadata instead of embedding large response bodies.
- `headers` has security restrictions (for example, direct `Authorization` and `Cookie` are blocked).
- Requests are subject to guard network policy.

## `web_search`

Purpose: run web search and return structured results (current implementation uses DuckDuckGo HTML).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `q` | `string` | Yes | None | Search keywords. |
| `max_results` | `integer` | No | `tools.web_search.max_results` | Maximum returned results (hard-capped at 20 in code). |

## `todo_update`

Purpose: maintain `TODO.md` / `TODO.DONE.md` under `file_state_dir`, including add and complete operations.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | `string` | Yes | None | `add` or `complete`. |
| `content` | `string` | Yes | None | For `add`: item text. For `complete`: matching query. |
| `people` | `array<string>` | No (`add` requires it) | None | Mentioned people (usually speaker, addressee, and other mentioned users). |
| `chat_id` | `string` | No | Empty | Task-context chat ID (for example `tg:-1001234567890`). Written to WIP entry metadata as `ChatID:`. |

Returns:

- On success, returns `UpdateResult` JSON with key fields:
  - `ok`: whether operation succeeded (boolean).
  - `action`: actual executed action (`add` / `complete`).
  - `updated_counts`: `{open_count, done_count}`.
  - `changed`: `{wip_added, wip_removed, done_added}`.
  - `entry`: primary changed entry (`created_at` / `done_at` / `content`).
  - `warnings`: optional warning array (for example, LLM rewrite hints).

Constraints:

- Controlled by `tools.todo_update.enabled`.
- Requires an LLM client and model; returns an error if not bound.
- `add` uses a "param extraction + LLM insertion" flow: `people` comes from tool params, then the LLM inserts `name (ref_id)` based on `content`, raw user input, and runtime context.
- `chat_id` currently accepts only `tg:<chat-id>` (signed int64, non-zero).
- `add` only accepts reference IDs in this set: `tg:<int64>`, `tg:@<username>`, `maep:<peer_id>`, `slack:<channel_id>`, `discord:<channel_id>`.
- Reference IDs in `add` must exist in contact snapshot `reachable_ids`.
- If some people in `add` cannot be mapped to reference IDs, the tool does not fail; it falls back to writing raw `content` and appends `reference_unresolved_write_raw` in `warnings`.
- `complete` relies only on LLM semantic matching (no programmatic fallback); ambiguous matches return an error directly.

Errors (string matching):

| Error substring | Trigger |
|---|---|
| `todo_update tool is disabled` | Tool is disabled. |
| `action is required` | Missing `action`. |
| `content is required` | Missing or empty `content`. |
| `invalid action:` | `action` is not `add/complete`. |
| `todo_update unavailable (missing llm client)` | LLM client not injected. |
| `todo_update unavailable (missing llm model)` | LLM model not configured. |
| `invalid reference id:` | Invalid `(...)` reference exists in text. |
| `missing_reference_id` | Mentioned person cannot be uniquely resolved to a reference ID. |
| `reference id is not reachable:` | Reference ID is not in reachable contacts. |
| `no matching todo item in TODO.md` | `complete` found no completable entry. |
| `ambiguous todo item match` | `complete` matched multiple candidates. |
| `people is required for add action` | `add` called without `people`. |
| `people must be an array of strings` | `people` is not a string array. |
| `invalid reference_resolve response` | Reference insertion LLM returned invalid JSON. |
| `invalid semantic_match response` | Semantic match LLM returned invalid JSON/schema. |
| `invalid semantic_dedup response` | Semantic dedup LLM returned invalid JSON/schema. |

Note: in current implementation, `missing_reference_id` is usually raised during internal LLM parsing and then downgraded to raw-content write; if an upstream layer directly consumes this error, it can still match on that string.

## `contacts_send`

Purpose: send a single message to one contact (auto-routed via MAEP/Telegram).

Contact profile maintenance:

- To read contacts, use `read_file` on `file_state_dir/contacts/ACTIVE.md` and `file_state_dir/contacts/INACTIVE.md`.
- To update contacts, use `write_file` to edit those files directly (following the YAML profile template structure).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `contact_id` | `string` | Yes | None | Target contact ID. |
| `chat_id` | `string` | No | Empty | Optional Telegram chat hint (for example `tg:-1001234567890`). |
| `content_type` | `string` | No | `application/json` | Payload type; must be envelope JSON type. |
| `message_text` | `string` | Conditionally required | None | Message text; the tool wraps it into an envelope. |
| `message_base64` | `string` | Conditionally required | None | base64url-encoded envelope JSON. |
| `session_id` | `string` | No | Empty | Session ID (UUIDv7). `contacts_send` always sends `chat.message`. |
| `reply_to` | `string` | No | Empty | Optional reply target `message_id`. |

Constraints:

- `contacts_send` always uses topic `chat.message` (caller does not pass `topic`).
- In Telegram runtime mode: `group/supergroup` sessions do not expose `contacts_send` by default; `private` sessions keep it available.
- If cross-session forwarding is needed in group chat (for example, explicit "DM someone"), trigger it via explicit task/command, not by routing ordinary group replies to `contacts_send`.
- If `chat_id` is provided:
  - It is used only when it matches the contact's `tg_private_chat_id` or `tg_group_chat_ids`.
  - Otherwise it falls back to the contact's `tg_private_chat_id`.
  - If still unavailable, the tool returns an error.
- At least one of `message_text` or `message_base64` is required.
- `content_type` defaults to `application/json`, and must be `application/json` (parameters allowed, for example `application/json; charset=utf-8`).
- If `message_base64` is provided, decoded payload must be envelope JSON containing `message_id` / `text` / `sent_at (RFC3339)` / `session_id (UUIDv7)`.
- Sending to human contacts is allowed by default; actual deliverability still depends on sendable targets in contact profiles (private/group chat IDs).

## `plan_create`

Purpose: generate execution-plan JSON. Usually called by the system for complex tasks.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `task` | `string` | Yes | None | Task description to plan. |
| `max_steps` | `integer` | No | Config default (usually 6) | Maximum number of steps. |
| `style` | `string` | No | Empty | Plan style hint, for example `terse`. |
| `model` | `string` | No | Current default model | Override model for plan generation. |

## `telegram_send_file`

Purpose: send a local cached file (document) to the current Telegram chat.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | Local file path. Supports absolute path or relative path under `file_cache_dir`. |
| `filename` | `string` | No | `basename(path)` | File name displayed in Telegram. |
| `caption` | `string` | No | Empty | Optional file caption. |

Constraints:

- Available only in Telegram mode.
- `path` supports `file_cache_dir/<path>` alias form.
- Only files under `file_cache_dir` can be sent; directories return errors.
- File size is limited by tool cap (currently 20 MiB by default).

## `telegram_send_voice`

Purpose: send a Telegram voice message from a local voice file.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `chat_id` | `integer` | No | Current context chat | Target Telegram `chat_id`. Required if there is no active chat context. |
| `path` | `string` | Yes | None | Local voice file path (recommended `.ogg`/Opus). Supports absolute path or relative path under `file_cache_dir`. |
| `filename` | `string` | No | `basename(path)` | File name displayed in Telegram. |

Constraints:

- Available only in Telegram mode.
- Only local-file sending is supported; inline text-to-speech is not supported.
- Local files are limited to `file_cache_dir` and file-size caps (currently 20 MiB by default).

## `telegram_react`

Purpose: add emoji reactions to Telegram messages.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `chat_id` | `integer` | No | Current context chat | Target Telegram `chat_id`. |
| `message_id` | `integer` | No | Trigger message ID | Message ID to react to. |
| `emoji` | `string` | Yes | None | Reaction emoji. |
| `is_big` | `boolean` | No | Empty | Whether to use Telegram large reaction style. |

Constraints:

- Available only in Telegram mode.
- Requires `message_id` context in Telegram mode (or explicit `message_id` input).

## Notes

- Runtime parameter validation is defined by code: `tools/builtin/*.go` and `cmd/mistermorph/telegramcmd/*.go`.
- If a tool is disabled by configuration, it returns a `... tool is disabled` error.
