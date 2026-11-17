---
branch: factory/FT145-chat-history-load-more-visual-polish
round: 1
---
# Polish the chat history “load more” control

## factory · 2026-11-17 18:59
Owner request from Console: the chat history “load more” button looks arbitrarily placed on the page. Polish its visual design and add this work to new/.

Scope and acceptance:
- Integrate the “load older messages” control into the top boundary of the conversation history with deliberate alignment, spacing, and visual hierarchy; it should read as part of the history, not a detached page action.
- Follow the Console's existing visual language; keep the control secondary to the conversation and composer rather than introducing an unrelated style.
- Make the layout and touch target work on desktop, mobile web, and Android, including light and dark themes.
- Provide coherent idle, loading, and disabled states without duplicate requests or distracting layout jumps; hide the control when no older history remains.
- Preserve cursor-based pagination, message order, and scroll-position anchoring when older messages are prepended. Do not change backend pagination or turn this into a broader chat redesign.
- Add suitable regression coverage and visually inspect the control in desktop and narrow layouts; record what was and was not verified.

## factory · plan · 2026-11-17 20:44

Behaviour: At the top of a loaded conversation with a nonempty older cursor, show a quiet, centered history-boundary row aligned to the conversation width and gutters. Use semantic theme colors, subtle rules and a compact icon/label, with a minimum 44pt touch target. Keep dimensions stable during loading, disable activation and communicate loading accessibly. No older cursor means no row; first load/empty placeholders remain unchanged. Errors retain the existing error handling and allow retry. Preserve message order, cursor pagination and list scroll anchoring, including when the boundary disappears on the final page.
Scope: ChatHistoryList header styling and narrowly related UI state/accessibility, regression fixtures/tests, English documentation only if necessary. No backend pagination, composer or wider chat redesign.
Decisions: Integrate the control in the List header, not a floating or sticky page action, to retain scrolling semantics. Reuse existing Button/theme primitives and existing controller duplicate-request guard. Avoid animations or a changing label that shifts layout; use existing loading indicator conventions. Prefer small changes and do not upgrade pinned dependencies to reconcile stale config wording (AGENTS says nsh 0.5.1).
Checking: Add tests covering idle/loading/hidden/final-page states, repeated activation guard as relevant, and prepend/anchoring behavior. Run gofmt gate, go vet ./..., go test ./..., nsh check, and scripts/test.sh (required concurrent script, not a sequential whole-suite run). Use existing visual tooling to inspect desktop and narrow layouts in both themes; honestly record inability to inspect native Android. Verify fixed layout and readable secondary contrast.

## factory · 2026-11-17 20:44

Built at a40e50db. The older-history button now sits centered between faint rules in the conversation column, in a stable 44pt boundary row. Shared Button forwards hitSlop for a 44pt touch target. Added localized loading accessibility labels and regression coverage for cursor requests, final-page disappearance, retry, duplicate activation, geometry and scroll positioning. Controller/backend pagination unchanged.

Decisions: reuse existing Button busy/disabled treatment; explicit center alignment overrides Button's default. Preserve existing top-of-list prepend behavior: at absolute top the older page appears below the boundary and pushes existing content down; scrolled down the visible message anchor stays in place, including the final page. Final-page boundary removal at absolute top retains existing behavior. No dependency or tool installs.

Tests: manager independently passed gofmt gate, go vet ./..., go test ./.... Coder passed nsh check and required scripts/test.sh: 133 files, zero failed; chat-attachments failed in parallel and passed the script's isolated retry. No unpinned installs.

Visual inspection reported by coder: headless Chrome at 1400x1000, 700x900, 390x844 with touch; idle/hover/loading/landed/final states and repeat-press behavior, compared with starting revision. Light and dark checked; current Console dark palette renders the same colors as light. Mouse hit box remains 32pt; touch hit slop extends it to 44pt. Native Android and desktop application not visually verified (no device/emulator/display); phone layout tests use Android platform mode. Owner/reviewer should inspect the history boundary on native Android and assess preserved absolute-top prepend behavior.

First code push failed because the credential helper required repository HTTP path; retry with per-command credential.useHttpPath=true succeeded. No global configuration changed.
