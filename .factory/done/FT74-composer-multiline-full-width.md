---
branch: factory/FT74-composer-multiline-full-width
round: 2
---
# Composer multiline mode must immediately use the full multiline text width

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

Follow-up to shipped FT69. The owner reports that the previous fix retains the single-line text-field width after entering multiline mode, apparently to keep wrapping triggered. This leaves an unacceptable intermediate layout.

### Acceptance criteria

- On entering multiline mode, immediately apply the intended full multiline text-field width together with the rest of the multiline layout. Do not retain the single-line width to force wrapping.
- Keep mode transitions stable even when the expanded width makes the text fit on one visual line. Define clean entry and exit conditions without intermediate states, oscillation, or height/width flicker.
- Cover typing near the wrap threshold, deletion, pasted text, explicit newlines, IME composition, and resizing. Verify rendered width and layout, not only a mode flag.

Intake only; implementation has not started.

## factory · plan · 2026-11-11 02:23

Behaviour: Decide row mode from an independent hypothetical single-row measurement. Multiline immediately takes the whole row, with height measured at that full width. Empty input returns to one row; explicit line breaks enter two rows. Keep input identity, focus, selection and composition. Ignore stale draft measurements and use a safe first-layout default.

Scope: Composer layout, measurement and regression tests; no unrelated placeholder or other UI changes.

Decisions: Remove the narrow intermediate state. Keep entry/exit independent of the displayed field width to avoid oscillation. Snap row transitions; animate only edit-driven height changes within an established multiline layout.

Checking: Cover threshold typing/deletion, pasted and restored drafts, explicit newlines, delayed measurements, IME and resizing. Check rendered dimensions, not only mode flags.

## factory · 2026-11-11 02:23

Built and pushed f14b796f. Removed the narrow intermediate layout; multiline uses full width immediately. Measurement results are draft-tagged, with unchanged-height drafts accepted after two frames. Row transitions snap to avoid animated intermediate widths; resize-driven height changes also snap. Added rendered geometry regressions and documented nsh behaviour in PORTING.md.

Tests: gofmt check, go vet ./..., go test ./..., nsh check passed. Manager independently reran these checks; the first full nsh run hit the tool timeout, and a detached retry completed with 527/527 passing. Coder also reported 527/527 passing.

UI: Coder checked real Chrome at desktop 1280 and phone 390 widths, including typing, deletion, paste, Shift+Enter, DevTools IME composition, selection replacement, sending and resizing, with frame-level geometry and screenshots. Native GPUI, Android and Mobile Safari were not checked. Headless tests cannot verify animation timing; animation behaviour was checked only in Chrome.

Installs: none. Existing browser and tooling reused. Initial branch push lacked credential repository-path context; retry with command-local credential.useHttpPath succeeded. No changes to machine git settings.

Moved new/ → review/ for independent review.

## factory · review · 2026-11-11 02:43
head: f14b796f3eb828564aef81a7b2171ea7adaa6bf8
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/composerRows.ts:91: The unchanged-layout early return leaves shownFor on the previous draft. Example: in multiline mode, type a character without changing either measured height, wait for the draft-tagged measurement, then resize so the height changes. The resize incorrectly calls LayoutAnimation.configureNext because draft differs from shownFor, easing widths instead of snapping. A scratch regression probe reproduced one animation call where zero was expected. Update shownFor in the early-return path only when measured.text equals draft, and add the type-then-resize regression. The proposed correction passed the probe and 23/23 composer tests in a scratch copy; the reviewed branch was not modified.

Validation: Claude Code reviewed all seven changed files against origin/master...HEAD and the request/plan. No P0/P1 findings. Mandatory gofmt check, go vet ./..., go test ./..., nsh check and nsh test --web-host tests/noHost.js passed; nsh 527/527. Review artifacts were inspected and the P2 reproduction independently rerun by a second Claude Code call after the first call returned an incomplete report. Branch worktree remains clean. Installs: none.

Residual risks: No independent real-browser animation or native GPUI, Android or Mobile Safari validation in this review. Headless geometry cannot verify actual wrapping/animation timing; native delayed measurement behavior remains unverified. Build-stage Chrome checks are recorded above, not claimed as independent review checks.

Moved review/ → ready/ under the factory rule allowing P2 notes; owner should inspect the resize animation finding before shipping. No linked GitHub issue or PR.

## factory · 2026-11-11 10:14

Owner requested Claude Code fixes for the two previously identified P2 findings. Fixed on existing branch: 49bbc7f0; merged origin/master d122775a without conflicts, head e1865a42. Unchanged-layout early return now updates shownFor only for the matching draft measurement. Added type-then-resize regression (fails before fix, passes after) and stale-measurement guard (rejects unconditional shownFor update).

Claude Code reports targeted composer 25/25 and geometry 21/21, gofmt cleanliness, go vet ./..., go test ./... (162 packages), nsh check and full nsh tests 540/540 passing with throwaway HOME. No installs. Manager inspected commits, source diff and clean worktree; did not independently rerun full suites. Actual visual animation, Chrome, native GPUI, Android and Mobile Safari not verified this round. Moved ready/ → review/ for fresh independent review; not shipped.

## factory · review · 2026-11-11 11:08
head: e1865a42200f988aa7f1f14606fd00f3d048a508
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/composerRows.ts:91-95: Updating shownFor on the first unchanged-layout report consumes an edit before the second measuring copy reports. In established multiline mode, sequential measurements (one-row 4L/full-width 2L, then 4L/3L) produce zero configureNext calls instead of one; a single combined report eases correctly. Headless desktop/phone paste-like integration probes reproduce snapped growth (51→85px / 101→185px). Both probes pass against pre-fix f14b796f, confirming a regression from 49bbc7f0. Defer unchanged-layout acknowledgement until measurements settle, or track both copies per draft; add a sequential-report regression while retaining the type-then-resize and stale-measurement guards.

Validation: Claude Code independently reviewed all seven files in origin/master...HEAD and the request/plan. No P0/P1 findings. Mandatory gofmt cleanliness, go vet ./..., go test ./... (162 packages), nsh check and nsh test --web-host tests/noHost.js passed (540/540), using throwaway HOME. Manager inspected successful suite logs and the failing targeted regression probe. The first coder call returned only a completion acknowledgement; a second call recovered the full review and verified pre-fix comparisons. Branch worktree is clean. Installs: none.

Residual risks: No independent real-browser or native GPUI/Android/Mobile Safari checks. Animation finding is verified through animation-call counts, not observed visual timing. Explicit-newline case uses synthetic measurements; paste-like integration reproduction uses rendered headless geometry. Native measurement order is unverified. Earlier build Chrome checks predate this fix and are not independent review checks.

Moved review/ → ready/ under the factory rule allowing P2 notes. Owner should inspect the sequential-measurement animation regression before shipping. No linked GitHub issue or PR. Not shipped.

## factory · 2026-11-11 12:33

Owner-authorized ship with Claude Code: FT68, FT72, fixed FT74 and FT75. Merge: f8daee10; combined master b8a014eb1a44f5e57656296cc38360e4f527d4f3 pushed. No tag created or pushed, as explicitly requested. Fixed latest sequential-measurement P2 in 848757d6; branch head 4125a66a. Unit and desktop/phone rendered regressions fail before fix and pass afterward; type-then-resize and stale-result guards retained. Settled measurement uses two frames; native ordering unverified, resize within that window can still ease. 

Combined validation: gofmt cleanliness, go vet ./..., go test ./..., nsh check, Console tests 611/611, core Node 259/259, Android manifest 6/6 and web build passed. Tests used isolated HOME/XDG directories. Manager inspected diffs and suite logs; did not independently rerun suites. FT72 Rust/native suites not rerun in this ship; previously recorded four baseline fixture failures remain. No browser visual or native device validation this round. No installs. No linked GitHub issue or PR. Moved ready/ → done/.
