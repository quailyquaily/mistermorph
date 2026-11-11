---
branch: factory/FT95-agent-link-file-transfer
round: 1
---
# File transfer support for Agent Link

## factory · 2026-11-11 20:02
Recorded from the owner's request:
> New feature request: add file transfer support for agent link. So they can share files.

Acceptance criteria:
- Agents connected through Agent Link can send files to one another, including files accompanying a text message and files returned in a reply. Extend the existing agent-send interface rather than requiring a separate manual transfer workflow.
- Transfer the actual bytes; a path on the sender's machine alone is not sufficient. The receiving agent gets attachment metadata and a usable local file reference within its allowed storage, even when agents do not share a filesystem.
- Preserve the original display filename, media type and byte size, and verify transfer integrity. Support binary files and zero-byte files without corrupting their contents.
- Use the existing authenticated Agent Link connection and recipient authorization. Do not expose public download links, credentials or arbitrary local filesystem access. Treat filenames and metadata as untrusted: prevent traversal, unsafe overwrites and accidental execution.
- Define and document bounded file size, transfer resource usage and temporary-file lifetime. Reject oversized or unreadable files clearly; interrupted, expired or failed transfers must not be reported as delivered or leave partially received files available as complete attachments.
- Keep existing text-only messaging, routing and reply behavior working. Handle peers without file-transfer support with an explicit unsupported error rather than silently dropping attachments.
- Add regression tests covering successful cross-agent transfer, byte integrity, text with attachments, reply attachments, empty files, unsafe filenames, size limits, unauthorized access, interrupted transfers and unsupported peers. Document the tool interface, limits, cleanup and failure behavior.

Scope decisions for implementation:
- Start with file attachments over Agent Link only; shared folders, directory synchronization and other messaging-channel attachment support are out of scope.
- Reuse existing attachment/cache facilities where suitable. Choose the simplest bounded transfer mechanism consistent with the current transport; avoid adding an external storage service unless demonstrably necessary.
- This records the feature request only; no implementation, merge or release is performed by this intake task.

## factory · plan · 2026-11-11 20:57
Behaviour: Extend agent_send with path and filename for Agent Link recipients, with optional text. Resolve permitted cache/workspace files, reject unreadable/oversized files before sending, and transport bytes via the authenticated connection. Validate capability, recipient authorization, size and digest before atomically publishing a unique receiver-local attachment; expose metadata/local reference to the receiving task and reply waiter. Preserve text-only behavior. Empty files are valid; unsupported peers, failures and interruptions must not claim delivery.
Scope: Agent Link transport, routing, tool schema, inbound/reply attachment handling, bounded cache lifecycle, regression tests and English docs. No other channel file features, external storage, forbidden-path changes or UI redesign.
Decisions: Prefer a bounded inline attachment representation on the existing authenticated transport if compatible with frame limits; use one file per tool call, a documented conservative byte limit, SHA-256 integrity and capability negotiation. Choose explicit resource/TTL bounds consistent with existing queue TTL, sanitize display names independently of generated storage names, and use private atomic cache writes. Validate every trust boundary, including relayed frames. Determine reply attachment interface from existing reply machinery and document it without breaking text replies. Do not interpret attachment contents as instructions or execute them.
Checking: Add tests with separate sender/receiver directories for binary and empty integrity, text+file, returned attachments, unsafe names/symlinks/outside-root paths, bounds, unauthorized recipients, interruption/expiry cleanup, unsupported peers and text compatibility. Run configured gofmt/vet/full Go tests using throwaway HOME. If Console sources must change for transparent relay/capabilities, run nsh check and nsh test --web-host tests/noHost.js. Record remote/multi-device/manual UI checks not performed.

## factory · 2026-11-11 20:57
Built actual-byte Agent Link file transport and agent_send path/filename support, including text with files, file-only messages and reply.attachments. Reply tasks can attach files through agent_send to the asking agent. Added capability negotiation, SHA-256 validation, authenticated recipient checks, safe atomic receiver-local cache storage, cleanup and bounds. Text-only messaging remains supported. contacts_send reuses the same Agent Link attachment route.
Decisions: 2 MiB combined file bytes per message; one file per tool call, up to four per message; 4 MiB frames; 16 MiB runtime queue and 32 MiB relay in-flight byte budgets; four concurrent incoming saves. Received files expire after seven days with caps of 256 files / 64 MiB; crash partials expire after one hour. No config keys added. New documentation is English; existing translated descriptions remain unchanged.
Commits: 48b53f1b, 334f8983. Installs/dependency changes: none (pinned modules restored only).
Tests: configured gofmt check, go vet ./..., and go test ./... passed in a throwaway HOME, independently rerun by manager. Coder also reports targeted race tests passed. Regression tests cover binary/empty bytes, replies, unsafe paths, authorization, limits, interrupted transfers and unsupported peers. No forbidden paths changed.
Not checked: separate physical machines, mixed-version Consoles, slow links, Android/Windows or manual Console attachment presentation. UI sources unchanged, so nsh tests were not required. No remote deployment or live transfer validation. Ready for review, not merged or released.

## factory · review · 2026-11-12 02:20
head: 334f89837314cf0b60938e0dd2b46ac66c31b8b7
verdict: pass
notes:
- [P2] internal/channelruntime/agentlink/runtime.go:437: asynchronous rejection of a queued reply with attachments drops the text answer too. Example: the asker rejects report.csv because its cache is full after SendWithAttachments returned queued; the fallback never runs. Observe final delivery failure and retry the text-only answer with the attachment failure note.
- [P3] internal/agentlink/conn.go:26: the increased 4 MiB frame limit permits text-only messages above the old 1 MiB limit to reach legacy runtimes and repeatedly disconnect them on retries. Example: a 2 MiB text message through a new relay to a legacy receiver. Enforce the legacy limit for peers without file capability.
- [P3] internal/agentlink/inbox.go:124: cleanup runs only upon another incoming file. Example: a crash partial remains beyond one hour indefinitely if no further file arrives. Add startup/periodic cleanup or document opportunistic retention explicitly.
- [P3] internal/channelruntime/agentlink/runtime.go:303: hop-limit rejection records attachment paths in history, then rejection removes their files. Later tasks see unusable paths. Omit local paths from rejected-message history or retain the referenced files.

Claude Code reviewed origin/master...HEAD; no P0/P1 findings. Required gofmt check, go vet ./... and go test ./... passed with an absolute throwaway HOME (162 packages ok). No installs or dependency changes; worktree unchanged and forbidden paths untouched. Merge compatibility with current master checked clean. Console sources unchanged; nsh checks not applicable.
Residual risks: inbox capacity eviction can remove files still referenced by queued tasks; slow links can cause duplicate transfer attempts. Not checked: live mixed-version Consoles, separate physical machines, Android/Windows, manual Console attachment presentation, or a fresh race-test run.
Moved review/ → ready/ under the configured no-P0/P1 review gate. Owner should inspect the P2 reply-loss case and P3 compatibility/retention/history notes before shipping. No linked issues or PRs. Not merged or released.

## factory · 2026-11-12 08:22
Merged into master with Claude Code: 94d0f342; pushed batch head 416ed2d1. No tag, per owner instruction. Both merges clean; no extra fixes. Configured gofmt/vet/full Go tests passed (162 packages); nsh check passed and Console tests passed 788/788. No installs. Existing P2/P3 review notes remain unresolved; live cross-machine transfers and native/browser platform checks were not performed. No linked issues or PRs to close. Branch retained. Moved ready/ → done/.
