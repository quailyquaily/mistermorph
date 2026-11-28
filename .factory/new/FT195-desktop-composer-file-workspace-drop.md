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
