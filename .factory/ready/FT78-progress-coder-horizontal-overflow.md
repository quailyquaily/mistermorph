---
branch: factory/FT78-progress-coder-horizontal-overflow
round: 1
---
# Allow horizontal scrolling for long progress and coder output

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: progress 和 coder 经常输出比较长的内容，不折行的话，就给横向滚动条。

Acceptance:
- For both progress and coder output, any content intentionally displayed without wrapping must be horizontally scrollable when it overflows.
- Do not clip long output or let it expand the chat layout or cause page-wide horizontal scrolling.
- Preserve existing intentional wrapping; do not force all content to be unwrapped.
- Verify long single-line output and multiline output at narrow and wide window sizes; scrollbars follow platform visibility behavior.

## factory · plan · 2026-11-11 05:33
Behaviour: Keep empty and first-run states unchanged. Constrain unwrapped progress and coder runs to the panel and enable horizontal scrolling when they overflow. Preserve existing wrapping, multiline boundaries, error rendering and vertical tail-follow.
Scope: Progress/tool and worker output containers, shared overflow renderer and regression tests; no backend or unrelated styling changes.
Decisions: Use nsh horizontal Scroll with platform scrollbar defaults. Runs that fit remain plain rows so nested scroll containment does not intercept vertical scrolling unnecessarily.
Checking: Long single-line and multiline output at narrow and wide widths, width containment, horizontal scrolling, wrapping and empty states; run repository and Console gates.

## factory · 2026-11-11 05:33
Built commit 22bd5c081f8062d1cd8a58397634c4bbe54c05a2 from base 2b4c2ee1. Added OverflowLine for progress titles, parameters, nested calls and worker process labels. Existing wrapping for output, notes and errors is preserved. Added ten regression tests and documented nsh scroll containment.
Tests: nsh check, nsh build and all 534 Console tests passed. gofmt, go vet ./... and go test ./... passed; manager independently reran the repository test command successfully.
Checks: Automated layout/scroll regressions cover 360, 760 and 1400pt. Browser screenshot and interaction artifacts were generated; manager did not visually inspect screenshots. Native Android/macOS behavior and real-device scrollbar appearance were not checked.
Installs: Temporary playwright-core browser automation dependency present in the run-local tooling directory; no project manifest or lockfile changed.
Operational note: First branch push failed because GitHub credentials required a repository path; retry with command-scoped credential.useHttpPath=true succeeded.
Moved new/ → review/. No linked issue or PR.

## factory · review · 2026-11-11 05:52
head: 22bd5c081f8062d1cd8a58397634c4bbe54c05a2
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD: no findings. Branch merges cleanly with the fetched master.
- Validation: gofmt check, go vet ./... and go test ./... passed; manager independently reran these gates with a throwaway HOME. nsh check passed; all 534 Console tests passed (0 failed).
- Installs: no additional installs reported by the reviewer.
- Residual risks: native Android/macOS behavior and real-device scrollbar appearance were not verified by this review.
- Moved review/ → ready/. No linked issue or PR; no GitHub comment required.
