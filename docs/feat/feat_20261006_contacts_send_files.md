---
date: 2026-10-06
title: "Send files through contacts_send"
status: implemented-v1
---

# Send files through contacts_send

## Goal

Let `contacts_send` send a local file to a contact using the same recipient and channel selection as text messages. This lets awareness, cron, and heartbeat tasks deliver reports and other generated files without depending on a current channel conversation.

Reuse the upload code behind the existing channel file tools. Do not add a separate contact router or require the model to choose a channel-specific tool.

This document specifies the requirement; see "Implementation notes (v1)" for how it was built.

## Current behavior

- `contacts_send` accepts text or a base64-encoded message envelope. It resolves contacts, chooses a channel, groups compatible recipients, and records delivery through `contacts.Service` and its outbox. Each tool call gets a new idempotency key (`manual:<uuid>`).
- Delivery happens in `contactsruntime.RoutingSender`, which owns its own in-process bus, delivery adapters and API clients. Telegram, Slack and LINE text goes through the bus (`publishAndAwait`); Telegram `@username` targets, Lark, Discord and Mixin call their APIs directly.
- Awareness tasks register `contacts_send` through the shared tool configuration. `$contacts_send` can opt it into a task, subject to existing host and runtime rules.
- Channel chat tasks register tools such as `telegram_send_file`, `slack_send_file`, and `lark_send_file`. These bind their destination to the current conversation. Awareness does not register them, and `$telegram_send_file` cannot create that context.
- The file tools resolve paths with `filecache.ResolveFile` (cache containment, regular file, size limit). Telegram, Slack and Lark upload code lives in their channel runtime packages (`telegram_api.go` `sendMultipartFile`, the Slack `files.getUploadURLExternal` flow in `slack_api.go`, the Lark tool adapter); Discord and Mixin use the shared `discordapi` and `mixinapi` clients.
- Every runtime puts the task's workspace directory in the run's context (`pathroots.WithWorkspaceDir`), including awareness, cron and heartbeat.
- `contacts_send` routes WeChat and WhatsApp text through the running channel runtime (`livesend`). Those platforms also have file transports, but `livesend.Sender` exposes text only.
- `agent_send` shares some schema and execution code with `contacts_send`. That does not make file delivery part of `agent_send` in this requirement.

## User-facing behavior

Add two optional parameters to `contacts_send`:

| Parameter | Meaning |
| --- | --- |
| `path` | One local file under `file_cache_dir` or the task's workspace directory, absolute or relative |
| `filename` | Optional display filename; defaults to the source file's basename |

When `path` is supplied, `message_text` is an optional caption (see "Captions"). Do not add a second `caption` parameter with the same purpose.

```json
{
  "contact_id": "tg:123456",
  "path": "file_cache_dir/reports/weekly.pdf",
  "filename": "weekly-report.pdf",
  "message_text": "This week's report."
}
```

File-only delivery is valid:

```json
{
  "contact_id": "slack:T_WORK:U_READER",
  "path": "reports/weekly.pdf"
}
```

Existing `chat_id` hints and comma-separated `contact_id` values keep their routing meaning. A hint must pass the same validation and fallback rules as a text send; a file must not gain a different way to reach a recipient.

### Where a file may come from

Two roots, resolved with `pathroots` from the run's context:

- `file_cache_dir`, the same root as the channel file tools.
- The task's workspace directory: the conversation's attached workspace, or the default `workspace_dir`.

A relative path, or one starting with the `file_cache_dir` or `workspace_dir` alias, is resolved the same way the file tools resolve paths. An absolute path must fall inside one of the two roots after resolving symlinks. `file_state_dir` is not allowed: it holds the configuration, contacts, auth profiles and guard data. A task that produced a file elsewhere copies it into `file_cache_dir` first; the tool description says so.

### Parameter validation

- Without `path`, preserve existing text and envelope behavior.
- With `path`, require a nonempty string identifying a regular file within the allowed roots. Reject directories, missing files, paths outside both roots, and symlinks that escape them.
- Reject `filename` without `path`, and non-string file parameters. Since `filename` requires `path`, this also rules out `filename` with `message_base64`.
- Reject `path` combined with `message_base64`. File delivery uses explicit parameters, not an attachment hidden inside an encoded envelope.
- With `path`, reject a non-string `message_text`; an absent or empty string is valid.
- Sanitize the display filename with the existing file-cache helper. A display filename never changes the source path or destination.
- Send one file per invocation. No file array, URL download, or inline base64 file data in this version.

The tool description and schema explain file-only sends, captions, supported channels, the two allowed roots, and copying a file from elsewhere into `file_cache_dir`.

### Captions

`message_text` is attached to the file when the channel supports a caption and the text fits; otherwise the file is sent first and the text follows as a separate message.

| Channel | Caption |
| --- | --- |
| Telegram | Attached up to 1,024 characters; longer text follows as a message |
| Slack | Attached as the upload's initial comment |
| Discord | Attached up to 2,000 characters; longer text follows as a message |
| Lark | Always a separate message after the file, as `lark_send_file` does |
| Mixin | Always a separate message; attachments carry no caption |
| WeChat, WhatsApp | As their file transports handle it today |

Limits are counted the way each platform counts them. When the text follows as a separate message, it uses the existing text path for that destination, including mention rules. If the file succeeds and the separate text fails, the result says the file was sent and the text failed (see "Failure behavior").

## Routing and channel support

Resolve the destination first through the existing contacts routing logic, then use that channel's file upload. Do not choose a different channel merely because it supports files. An unsupported selected channel returns a clear failure.

| Channel | File behavior | Reuse |
| --- | --- | --- |
| Telegram | Always a document (`sendDocument`), even for images; keep a resolved topic/thread target | Document upload behind `telegram_send_file` |
| Slack | Upload and share in the resolved channel; keep supported thread information | External upload flow behind `slack_send_file` |
| Lark | Upload and send a file message to the resolved chat or user | File upload behind `lark_send_file` |
| Discord | Send in the resolved channel, opening a DM when existing routing requires it | `discordapi`, as `discord_send_file` |
| Mixin | Upload an attachment and send it in the resolved conversation | `mixinapi`, as `mixin_send_file` |
| WeChat | Send through the running runtime, with its conversation context and media handling | File transport behind `wechat_send_file` |
| WhatsApp | Send through the running runtime, with its account rules and media handling | File transport behind `whatsapp_send_file` |
| LINE | Explicit unsupported-file-delivery error | No general file sender to reuse |

WeChat and WhatsApp may deliver an image or video as media, as their file tools do. No media-type selector is added.

Keep existing target restrictions, credentials, and API error handling. WeChat and WhatsApp require a running runtime in the same process; a missing runtime or account context is an error, and no other account connection is created.

### Delivery path

File sends call the shared upload operations directly from `RoutingSender`, not through its in-process bus. The bus carries text envelopes; carrying files would need a new payload type and changes to every delivery adapter, for no benefit, since the sender already calls APIs directly for Telegram `@username` targets, Lark, Discord and Mixin. `contacts.Service` still writes the outbox record around the send exactly as for text, so status, failure cooldown and outcomes stay on the existing path.

A file send is synchronous: the tool returns after the upload and any separate caption complete or fail.

### Multiple recipients

Reuse current recipient resolution and grouping. If several contacts share one planned destination, upload the file once for that plan item and keep the existing mention rules in the caption. Separate destinations get separate deliveries of the same file.

Validate the file arguments once, before the first delivery. Keep the existing batch result structure, reporting each attempted destination and its outcome. A successful delivery is not rolled back if a later destination fails, and successful destinations are not resent.

## Awareness and scheduled tasks

No channel-specific `$..._send_file` reference is needed. A scheduled task can request:

```text
$contacts_send Generate the weekly report, save it under file_cache_dir, and send the PDF
to tg:123456. Include a short summary as message_text.
```

The reference makes `contacts_send` available under its current opt-in rules. It does not execute a send by itself, enable a missing channel, or provide credentials. The model still supplies the file and recipient in a normal tool call.

Use the same implementation in awareness, cron, heartbeat, CLI tasks, standalone channels, and Console-managed runtimes wherever `contacts_send` is available. A cron notification target alone never sends an attachment; file delivery needs an explicit tool call with a resolved recipient.

This feature does not depend on [tool search](feat_20261006_tool_search_progressive_disclosure.md): `contacts_send` is a built-in tool and stays visible.

## Implementation requirements

### Tool and contacts service

- Extend only the `contacts_send` public schema. Keep `agent_send` text-only, and reject file parameters there rather than ignoring them.
- Resolve the allowed roots from the run's context (`pathroots.Resolve`) and existing runtime configuration. No new path setting.
- Carry validated file metadata separately from message text through the contacts decision and delivery path. A `message_base64` envelope never causes a local file to be opened.
- Keep contact status, current-conversation restrictions, guard checks, approval handling, and recipient grouping on the existing execution path.
- Keep the single-recipient and batch outcome shapes. Never report success when an upload fails.

The likely integration points are `tools/builtin/contacts_send.go`, `internal/toolsutil/static_register.go`, `contacts/`, and `internal/contactsruntime/`. These change the current path; they are not a new sending service.

### Shared channel code

Move the uploads that live inside channel runtimes into shared packages, and call them from both the runtime's file tool and `RoutingSender`:

| Channel | Today | Target |
| --- | --- | --- |
| Telegram | `sendMultipartFile` in `internal/channelruntime/telegram/telegram_api.go` | A document upload in a shared Telegram API package |
| Slack | `files.getUploadURLExternal` flow in `internal/channelruntime/slack/slack_api.go` | Alongside the shared `slackclient` |
| Lark | Upload in `internal/channelruntime/lark` | A shared Lark API package |
| Discord, Mixin | `discordapi`, `mixinapi` | Use as is |

Keep each channel tool's parameters and behavior. Do not duplicate multipart construction, Slack's upload sequence, attachment encoding, or response parsing in `contacts_send`. No wrappers that only rename a function, and no general transport framework.

Add a file operation to `livesend.Sender` for WeChat and WhatsApp, backed by their existing transports and account context, instead of invoking a chat-bound tool with a made-up conversation.

### File limits and lifetime

Check containment and that the file is a regular file before any network activity, and again at delivery, since the file may change or disappear in between.

Use a 20 MiB ceiling for `contacts_send` uploads, lowered by any smaller channel limit. Discord's existing default is 10 MiB. WeChat and WhatsApp keep their transport limits. No channel's configured limit is raised, and no new size setting is added.

Read or stream the file only after validation. Do not copy it elsewhere or put its contents into the model's context. Keep the source file after sending.

Approval stays attached to the normal tool call, including recipient, path, filename and caption. Resume checks the file again. This version does not promise an unchanged file while approval is pending.

### Audit and approval

File sends widen what a task can send out compared with text, and scheduled tasks run unattended. So:

- The guard audit log records every file send: recipients, resolved path, display filename, size, and SHA-256 of the content sent.
- File sends follow the same guard and approval policy as text sends. No extra approval is required for scheduled tasks: unattended delivery is the point of the feature, and an approval nobody answers would stall the task. A deployment that wants approval for them configures it through the existing guard rules.

### Outbox and failure behavior

Record file metadata (path, display filename, size, hash) with the existing delivery record, so an outcome can be identified as a file send. Never store file bytes or credentials there.

Idempotency stays as it is. Each tool call gets a new key, so a repeated call is a new send by design. A retry with the same key, for example inside the delivery path, must not upload the file twice.

An outbox record does not keep the file. If an attempt finds the file deleted, it reports the missing file; it never sends only the caption.

Distinguish these outcomes:

- Invalid file arguments: rejected before delivery.
- Unsupported channel or unavailable runtime: delivery failure; never the local path as text instead.
- Upload failure: no caption-only fallback.
- File sent, separate caption failed: reported as such; not full success, and no automatic re-upload.
- Batch partial success: successful outcomes kept, failures reported with the existing result contract.

No background retries or retry queue. Delivery status and failure cooldown follow the contacts service's current rules.

## Implementation notes (v1)

- `tools/builtin/contacts_send_file.go` validates the file once per call (`parseContactsSendFile`): parameter types, roots from `pathroots.Resolve` (`ContactsSendToolOptions.PathRoots`, wired from the common path roots), symlink-resolved containment, the `file_state_dir` exclusion, regular file, the 20 MiB ceiling, and size plus SHA-256. A relative path is looked up in `file_cache_dir`, then in the workspace. `agent_send` uses a schema without the file parameters and rejects them (`contactSendExecutionPolicy.allowFiles`).
- `contacts.ShareDecision.File` and `BusOutboxRecord.File` (`contacts.ShareFile`) carry path, display filename, size and hash. The envelope still carries the caption, which may be empty for a file.
- A caption that fails after the file went out is a `contacts.PartialDeliveryError`. The service records the delivery as sent, so a retry with the same key is deduped, and reports `accepted: true, partial: true` with the error; it does not put the contact in failure cooldown. The outbox record keeps no error text for it, since a sent record has none.
- `RoutingSender` dispatches file decisions in `internal/contactsruntime/sender_file.go` after the usual target resolution, without the bus. `prepareFileSend` checks the file again (still the same resolved path, regular, same size, within the channel limit) before any upload.
- Shared uploads: `internal/telegramapi` (`SendFile`, `CaptionFits`), `slackclient.Client.UploadFile`, and `larkapi.Client` (messages, uploads, JSON posts; the Lark runtime embeds it and `RoutingSender` now sends Lark text through it too). The runtimes' file tools call the same code. Discord and Mixin use `discordapi` and `mixinapi` directly.
- Mixin file and caption go out as separate messages; the caption does not quote the file, because conversation fan-out gives every recipient a different message ID. The file message ID comes from the idempotency key, so Mixin drops a repeated one.
- `livesend.Sender` gained `SendFile`; the WeChat/WhatsApp runtime implements it with its transport, `outboundFile` and the transport's size limit.
- Audit: the engine puts `guard.WithAuditContext` in each tool's context when the guard is enabled, and `guard.AuditFileSend` writes a `FileSend` event per delivery (recipients, path, filename, size, SHA-256, status). An audit write failure is reported as `audit_error` in the tool result, since the file already went out. Without an enabled guard there is no audit log to write.
- Approval resume runs the tool again, so the file is validated again.

## Acceptance criteria

| Case | Expected result |
| --- | --- |
| Existing text and encoded-envelope sends | Same routing, payload behavior, and outcome shape as before |
| File with caption | File contents, display filename, recipient, and caption reach the selected channel |
| Caption over the channel's limit | File sent, then the text as a separate message |
| File without caption | Delivered without requiring message text |
| Paths in `file_cache_dir` and the workspace | Relative, alias and absolute forms work when contained in either root |
| Path in `file_state_dir` or elsewhere, escaping symlink, missing file, or directory | Rejected before upload |
| Empty path, wrong parameter type, filename without path, or file plus encoded envelope | Clear argument error |
| Oversized file | Rejected under the tool and channel limits |
| Telegram topic, Lark user, or Discord DM target | Existing target resolution preserved |
| Shared group destination | One upload per planned destination; mention rules kept |
| Separate destinations | Each gets the same file and its own outcome |
| Current-conversation or host restriction | File parameters cannot bypass it |
| LINE selected | Explicit unsupported error; no file or caption-only send |
| WeChat or WhatsApp runtime absent | Clear failure; no new account connection |
| Upload or caption failure | Accurate failure or partial result; no duplicate upload |
| Retry with the same idempotency key | No second upload |
| File removed before approval resume | Clear error; no false success |
| Audit | Each file send is logged with recipients, path, filename, size and hash |
| Awareness or cron uses `$contacts_send` | Schema includes file parameters, with the same roots and routing |
| Existing channel file tools | Behavior unchanged after moving their uploads to shared code |
| `agent_send` | Schema remains text-only; file parameters rejected |

Use fake senders, local HTTP test servers, and stub live runtimes. Tests must not send real messages, require credentials, or connect to databases.

## Implementation sequence

Write and run failing tests before each phase's production changes.

1. **Tool and delivery contract:** file parameters, root resolution and validation, captions, single and batch decisions, outbox metadata, audit records, and the `agent_send` boundary.
2. **Shared uploads:** move the Telegram, Slack and Lark uploads into shared packages, wire them and Discord and Mixin into `RoutingSender`, and confirm the existing channel tools still pass.
3. **Live runtimes and integration:** the `livesend` file operation for WeChat and WhatsApp, the LINE error, propagation to awareness and Console-managed runtimes, failure cases, and approval resume.
4. **Documentation and regression checks:** update `docs/tools.md`, add scheduled-task examples, and run the affected suites and repository checks.

## Outside this requirement

- File support for `agent_send`.
- A new `contacts_send_file` tool or new channel-specific `$` loading rules.
- Sending from `file_state_dir` or other roots.
- LINE file transport, new messaging channels, or new authentication flows.
- Multiple attachments in one call, remote file URLs, or inline file bytes.
- Automatic channel fallback, background retries, or durable attachment storage.
