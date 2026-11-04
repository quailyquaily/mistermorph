---
branch: factory/FT4-console-coder-output-plain-text
round: 1
---
# Console: show coder output as plain monospace text in progress

## lyric · 2026-11-03 22:27

In the chat progress panel, `$coder` output (Codex and Claude Code) is rendered as Markdown (`MarkdownContent` in `web/console/src/components/ChatStatusCard.js`). Show it as plain text in the monospace font instead, the same way the other activity output is shown.

### Acceptance criteria
- Coder output in the progress panel is plain text in the same monospace style as other tool output; Markdown syntax shows as written, not rendered.
- Line breaks and indentation are kept; long output wraps or scrolls like other activity output.
- The coder-specific Markdown styling for the dark progress surface is removed if nothing else uses it.
- The final assistant reply in the chat is unchanged.

## factory · plan · 2026-11-04 20:38
Behaviour: Render both coder streams as escaped plain text in the shared monospace activity-note style. Preserve line breaks and leading indentation, hide whitespace-only output, retain error priority, summary fallback, child activities and scrolling behavior.
Scope: Progress renderer, unused coder-only CSS and focused regression tests. Final assistant Markdown, backend and worker roster are unchanged.
Decisions: Reuse the existing activity-note renderer; preserve meaningful output whitespace without adding dependencies.
Checking: Cover both streams, literal Markdown/HTML, indentation, empty/error fallback, child activity behavior and unchanged final reply rendering. Run frontend tests/build and repository Go checks; visually inspect if available.

## factory · 2026-11-04 20:38
Built and pushed e29914ae (fix(console): render coder progress as plain text).
Both coder streams now use the shared plain-text activity note; unused Markdown import and dark-surface styling removed. Added regression coverage and updated related assertions. No protected paths changed.
Decisions: Meaningful activity output retains its original whitespace; whitespace-only output uses the existing summary fallback.
Installs: No unpinned tools installed; no dependency manifest or lockfile changes.
Tests: Manager independently verified Go formatting, go vet ./..., go test ./..., pnpm test (359 passed) and pnpm build. Build emits a non-failing large-chunk warning.
Not checked: UI visual verification was not completed because Chromium failed to launch. Owner should inspect coder progress wrapping/indentation and final assistant Markdown in the browser.
Moved new/ → review/; round 1.

## factory · review · 2026-11-04 20:44
head: e29914aed94c321268344b51084ef03fc1a53ad1
verdict: pass
notes:
- Codex reviewed the complete origin/master...HEAD diff (four files); no findings.
- Validation: Go formatting, go vet ./... and go test ./... passed with an isolated environment and throwaway HOME. Initial inherited-environment failures also reproduced on base; not introduced by this change.
- Frontend: pnpm test passed 359/359; pnpm build passed with a non-failing chunk-size warning.
- Installs: restored pinned dependencies only; no unpinned tools or dependency changes.
- Residual risk: browser visual verification was not completed; owner should check progress indentation, wrapping and scrolling.
- Review execution deviations reported by Codex: initial skill discovery enumerated filenames outside the run directory without reading contents; pnpm automatically performed its locked dependency policy check. No source changes or commits were made.
- Moved review/ → ready/. No linked GitHub issues or PRs.
