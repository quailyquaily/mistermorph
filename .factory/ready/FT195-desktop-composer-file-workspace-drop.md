---
branch: factory/FT195-desktop-composer-file-workspace-drop
round: 1
---
# Desktop composer: drop files as attachments and directories as workspaces

## factory · 2026-11-28 11:52
Owner request, quoted verbatim: “桌面版想加一个功能 拖拽\n\n不管是Workspace还是File，都可以拖拽进这个 composer 里面。如果拖拽的是一个目录，就识别为 workspace。\ncc 先调研一下可行性。” Follow-up: “但是能识别出 drop 到 composer 吗？因为也可能别的功能也支持拖拽。 cc 看看” Authorization after the investigation: “ok 安排放到 factory new/”.

### Scope and behavior
- Implement native OS file-manager drops onto the desktop composer. Files become attachments through the existing upload/copy, progress, retry, removal and send pipeline; they are not merely inserted as path text.
- Detect directories on the host and treat a dropped directory as a pending workspace selection. Reuse manual workspace selection/binding semantics: show the selection before send and apply it on send, including replacement of an existing binding where currently supported.
- Only allow a local directory as a workspace for an eligible local backend. Reject remote-backend/local-directory combinations with an actionable explanation; do not transmit a local path as a usable remote workspace.
- Accept multiple files in their original order. Support one directory plus files when compatible with existing send behavior. Reject multiple directories explicitly rather than silently selecting one; preserve the existing draft and selections on rejection.
- Receiving a drop must not send a message or start a task. Preserve current task-running, workspace-change, upload-size/type and access restrictions; explain rejected paths, unreadable paths and failed uploads without losing the draft.
- Application-internal Workspace/file-tree dragging is explicitly out of scope for this first item: it uses different gestures and backend-owned files must not be uploaded again. Preserve existing internal interactions.

### Drop target isolation (required)
- Register native file-drop handling on the composer container, not the page/window root. A drop outside the composer must not attach files or select a workspace.
- Preserve independent drop targets elsewhere in the UI. Nested targets should follow existing innermost-target consumption semantics without duplicate handling or bubbling into the composer.
- Dialogs/overlays must block drops to the composer behind them. Avoid introducing a global drop dispatcher if existing native hit testing suffices.
- Show a clear composer-local drop affordance/highlight where supported by existing drag events; clear it after drop, leave or cancellation. Do not claim directory/file classification before host validation.

### Investigation evidence to recheck on the implementation base
Read-only Claude Code research reported an existing native system-file drop channel and position-based hit testing via `file_drop_target` in `desktop/nsh/vendor/nsh-platform-gpui/src/input.rs`. Registering `onFileDrop` on the composer was reported to target that container, favor the innermost registered target and respect modal blocking. This was source-level evidence, not a real desktop test; verify actual event payloads and tests before implementation. Likely application integration points: `desktop/nsh/src/host.rs`, desktop file helpers (`files.rs`), `ChatComposer.tsx`, and `chatController.ts`. Reuse the existing attachment/workspace flows and native bridge; avoid nsh/GPUI changes unless an actual missing capability is demonstrated.

### Acceptance checks
- Drop one/multiple files inside the composer; verify pending attachments, order, removal, retry, and delivered file references after send, including a new conversation.
- Drop a directory onto new and existing conversations; verify visible pending workspace state, send-time binding/replacement and rejection for a remote endpoint. Cover a directory plus files and explicit rejection of multiple directories.
- Verify composer versus outside regions, a second independent drop target, nested targets, and an open modal: only the intended target consumes each drop, exactly once.
- Cover empty payloads, invalid/unreadable/deleted paths, Unicode/spaces, repeated drops, task-running restrictions, and endpoint/topic changes during asynchronous classification/upload. No stale completion may alter another draft or endpoint.
- Add focused frontend/host regression tests; run repository-required Go checks and Console `nsh check` plus `scripts/test.sh` when affected, and appropriate Rust checks when host code changes.
- Document Windows path and macOS directory-permission considerations; check Linux X11/Wayland where available. Explicitly report which real desktop/platform and visual interactions were tested versus source/test-only verification. Lack of cross-platform hardware is not grounds for claiming verification or for blocking automated implementation.

Queue only now. Implementation, review and shipping follow the normal factory process.

## factory · plan · 2026-11-28 12:26

Behaviour
1. Only the desktop composer container consumes native OS file drops, using the existing native hit testing; other targets, nested targets and modal isolation remain intact. Highlight only for actual supported drag lifecycle events and clear after exit/drop/cancel.
2. Validate host paths asynchronously as a batch before changing selections: empty drops are no-ops; reject invalid/unreadable paths and multiple directories without losing the draft or existing selections. Preserve input file order and Unicode/spaces.
3. Register files with the existing native picked-file registry and feed the existing attachment upload/progress/retry/removal/send flow. One validated local directory becomes visible pending workspace state through existing manual workspace semantics, applied only on send.
4. Reject directories for ineligible/remote endpoints with a useful error. Respect task-running/attachment/workspace restrictions. Guard async completions by endpoint/topic/draft generation so no result modifies a different draft. Receiving a drop never sends or starts a task.
Scope
Use desktop host/files helpers, Console native bridge, ChatComposer and chat controller/page wiring plus focused tests/documentation. No application-internal dragging, global dispatcher, backend-file reupload or new vendor behavior unless required by a demonstrated gap. Preserve existing manual selection and send behavior.
Decisions
Use native onFileDrop closest-container hit testing (confirmed in input.rs), not page/window listeners. Validate all dropped entries before applying a batch; reject multiple directories explicitly rather than choosing one. Reuse existing local-backend eligibility and workspace-change checks rather than inventing endpoint rules. Native test/source verification is distinct from real platform testing.
Checking
Add host classification tests and frontend/controller integration regressions for paths, ordering, mixed batches, remote restrictions and stale async completions. Verify actual event payload/drag lifecycle and target/modal behavior in existing vendor tests or focused tests. Run gofmt check, go vet ./..., go test ./...; Console nsh check and scripts/test.sh; appropriate Rust checks for host edits. Document Windows paths/macOS permissions/Linux X11-Wayland limitations; explicitly report no visual or real desktop verification if unavailable.

## factory · 2026-11-28 12:26

Built and pushed commit 09042436 (feat(desktop): drop files and folders on the composer).
- Host validates native file URLs as a whole batch; files reuse attachment registration/upload and one directory reuses pending workspace selection, applied on send. Invalid/unreadable paths and multiple directories are rejected without changing the draft.
- Composer-local drop target uses native closest-target/modal hit testing. Remote endpoint directories are refused. Stale asynchronous results release their files instead of modifying another draft. Existing upload restrictions and retry/removal/send paths remain in use.
- Pending workspace is shown as a removable pill, including manual selections. Removing it also removes draft attachments uploaded into that directory, whose references would otherwise no longer resolve. No vendor or global-dispatch changes.
- Checks: manager independently reran gofmt cleanliness, go vet ./... and go test ./... successfully. Claude Code reports nsh check clean; Console scripts/test.sh 178 files, zero final failures (chat-attachments passed isolated retry); 12 new drop tests pass; desktop cargo test --offline 102 passed, 5 ignored, plus nsh_features 1 passed. Rust fmt unavailable for the pinned toolchain.
- Installs: none; no dependency/lock changes.
- Not checked: real file-manager drag/drop on Linux X11/Wayland, macOS or Windows; real native drag highlight lifecycle, OS permissions and visual interaction. Highlight drawing was inspected in a headless Chrome fixture screenshot only. Modal blocking relies on native source plus headless dialog isolation tests. Task-running/edit restrictions have module-level rather than full-app checks. Platform notes are documented in English.
- Outside allowed work areas: Claude Code also wrote an item memory file and a memory-index entry in its own user-home memory area. No new direct /tmp entries were observed. No machine paths are recorded here.
- Claude Code reports a reached weekly overage quota; no further coder call was attempted. Provider-reported reset interval at return: 4 days 2 hours.
Move: new/ → review/. Round 1. Await independent factory review; not merged or shipped.

## factory · review · 2026-11-28 13:01
head: 090424361c279aacd4ef0f4ebbe7683c92914263
verdict: pass
notes:
- [P3] web/console-nsh/components/chat/fileDrop.ts:109-128: Concurrent drops on the same draft apply in host-answer order rather than drop order. A slow earlier directory drop can overwrite a later workspace selection. Example: drop A (directory a plus f1) is delayed; drop B (directory b plus f2) completes first; A then completes, selecting a after f2 was uploaded into b. A focused scratch-copy handler probe confirmed the reversed workspace/file application order; the mismatched send references were traced in the controller. Serialize same-draft drop application or otherwise preserve event order. The full-app delayed-host probe timed out, so that portion is source-traced, not end-to-end verified.
- Independent Claude Code review of origin/master...HEAD covered all 12 changed files, native target/modal isolation, path/upload trust boundaries, workspace and attachment lifetime, async scope changes and restriction rechecks. No P0/P1 findings; no product files changed and no commits made by the reviewer.
- Required Go check passed: gofmt cleanliness, go vet ./..., go test ./... (173 tested packages). Console nsh check passed; scripts/test.sh: 178 files, zero final failures (contacts passed isolated retry). Rust cargo test --locked --offline with environment library shim: 102 passed, 5 ignored, plus one passed; all four new host drop tests passed. Tests used throwaway HOME/XDG directories.
- Additional non-required lib node test sweep: one pre-existing failure in lib/core/solo.test.mjs, reproduced without this change. Vendored GPUI tests could not run from this workspace; pinned rustfmt unavailable. No live desktop drag/drop, Linux X11/Wayland, macOS permissions, Windows paths, native modal/highlight lifecycle or visual verification.
- Residual risks: existing manual-workspace replacement attachment-reference behavior; unchanged vendor backslash/non-UTF-8 path handling; broadened local host file-URL API has no identified untrusted JS entry. These were not established as new actionable defects.
- Installs: none. Working tree clean apart from ignored Console build output. No reported project-memory/settings writes. Coder harness output in a generic /tmp location was recorded for owner-confirmed cleanup only; not deleted. Shared package caches reused.
Move: review/ → ready/. P3 is non-blocking under factory policy. Not merged or shipped.
