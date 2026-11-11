---
branch: factory/FT86-workspace-path-home-middle-ellipsis
round: 1
---
# Workspace right panel: home shorthand and single-line middle truncation

## factory · 2026-11-11 13:08
Recorded from the owner’s UI fix request.

Request:
> The workspace right panel, use ~ to indicate the home folder, keep the path in one row, do not wrap. If there are too many characters, use "..." in the middle of the full path

Acceptance criteria:
- In the workspace right panel, display the workspace home directory as `~` and descendants as `~/...`, using the relevant workspace host's home directory rather than assuming the client's home.
- Only abbreviate the actual home directory or its descendants; do not replace unrelated matching path substrings or sibling paths with similar prefixes.
- Keep the displayed path on one line without wrapping or overflowing the panel.
- When the available width is insufficient, truncate the middle with literal `...`, retaining the beginning and end of the path. Adapt when the panel width changes; leave paths that fit untruncated.
- This is a display change only: retain the original full path for filesystem operations and any existing copy/open actions.
- Test home, home descendant, non-home, short and long paths, and narrow/resized panel widths. Check web and Android app rendering; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 14:41
Behaviour: Use the actual workspace host's home metadata to abbreviate only home and descendants. When unavailable keep the original path. Measure the available row and path through nsh layout, keep fitting paths intact and otherwise insert literal ... in the middle, adapting on resize. Empty/unavailable states remain unchanged; operations and tooltip retain raw paths.
Scope: Workspace path presentation, controller metadata, minimal runtime home metadata and regression tests. No unrelated UI changes.
Decisions: Host-provided metadata, no client-home guessing; shared cross-platform layout APIs; preserve both ends with preference for the last directory.
Checking: Home/descendant/sibling/nonhome/no-home, narrow/wide and resized panels, path switching, wide characters, raw-path operations; configured Go checks and full nsh checks/tests; record actual web and Android visual coverage.

## factory · 2026-11-11 14:41
Built with Claude Code; pushed fc237be1 and a118745b. Added host home metadata to topic/workspace responses, endpoint-specific client metadata, home-boundary formatting and a measured single-line middle-ellipsis component. Existing filesystem actions and raw tooltip/accessibility paths are unchanged.
Decisions: Unknown home leaves paths unchanged; root homes are not abbreviated. Tail gets at least half of the remaining room. Text selection copies the displayed abbreviated/truncated text, not the raw path (nsh provides no selection-copy substitution); reviewers should check this against the copy-preservation criterion. Existing open/insert/download actions use raw paths.
Installs: None.
Verification: Manager reran the configured gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js on the final commits, using an absolute throwaway HOME. All passed; 657 nsh tests passed, zero failed. Only scoped item commits exist since the start point; no forbidden paths changed.
Visual checks: Coder checked the live web Console in headless Chrome across 390–1600pt widths, including home/sibling/nonhome paths, resize and topic switching. Android device/emulator rendering and native desktop rendering were NOT checked; Android coverage is a headless platform fixture only.
Push initially failed because the credential helper lacked the repository path; retried successfully with command-scoped credential.useHttpPath=true.
Moved new/ → review/. Owner/reviewer: inspect path rendering and selection-copy behavior; Android visual verification remains outstanding.
