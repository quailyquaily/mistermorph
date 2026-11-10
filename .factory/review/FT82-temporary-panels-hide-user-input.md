---
branch: factory/FT82-temporary-panels-hide-user-input
round: 1
---
# Remove the user input message from progress and coder temporary panels

## factory · 2026-11-11 00:58
Requested by the owner: “The temporary panel for progress and coder, remove the user input message from this page top. Add to nee”

Treat “nee” as `new/`.

Requirements:
- In both the progress and coder temporary panel views, remove the originating user input message displayed at the top.
- Keep the progress/coder output and existing panel controls intact; do not leave an empty message container or its spacing behind.
- This is a panel-only presentation change. Preserve the original user message in the main conversation and stored history.

Acceptance: opening either temporary panel shows its progress/coder content without a repeated user input message at the top.

## factory · plan · 2026-11-11 07:50
Behaviour: Progress and coder detail panels show their title, status/avatar, close control and live output without repeating the originating user message, including empty and failed states. The main conversation retains the message.
Scope: Panel context rendering and regression tests only; no history or persistence changes.
Decisions: Suppress the entire context node for activity and coder workers, including padding. Preserve context in plan, reasoning and subagent panels.
Checking: Test desktop and phone panels, switching types, streaming, empty and failed states, preserved conversation and controls. Run repository Go checks and Console type checks/tests. Visual device checks remain separate.

## factory · 2026-11-11 07:50
Built and pushed commit 02dbe9e7 on factory/FT82-temporary-panels-hide-user-input.
Progress and coder panels omit the context node and its spacing. Added regression tests for desktop/phone, streaming, switching panel types, empty/failed replies and preserved conversation messages.
Decisions: Coder identification uses normalized worker kind. When a worker is missing entirely, its kind is unknown and context remains visible; plan, reasoning and subagent context stays unchanged.
Installs: none; no manifest or lockfile changes.
Tests: configured gofmt check, go vet ./... and go test ./... passed, independently repeated by manager with a throwaway HOME. Claude Code reports nsh check passed and nsh test --web-host tests/noHost.js passed (524 tests); targeted panel tests passed 15/15 and four fail against old implementation.
Not checked: visual inspection in browser, desktop or Android; spacing verified structurally only. Failed/canceled coder workers with existing output were not independently covered.
Initial branch push credential helper required command-local credential.useHttpPath=true; retry succeeded without settings changes.
Next: review the branch and visually confirm both temporary panels.
