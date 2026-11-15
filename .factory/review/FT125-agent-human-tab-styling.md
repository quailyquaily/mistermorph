---
branch: factory/FT125-agent-human-tab-styling
round: 1
---
# Agent/Human selector: use tab styling

## factory · 2026-11-15 09:26

Owner request:
> Apply tab style to the agent human buttons, they are a tab.
> Add to the new status.

Acceptance criteria:
- Present the existing Agent/Human selector as tabs rather than standalone buttons, using the app's established tab styling and spacing.
- Clearly distinguish the active tab and preserve existing selection, filtering, labels, and counts where present.
- Apply consistently on mobile and desktop without overflow or reduced touch-target usability.
- Preserve keyboard operation and accessible selected-state semantics appropriate to the selector's actual behavior.
- Add regression coverage for switching between Agent and Human and verify active-tab presentation in both viewport sizes.

## factory · plan · 2026-11-15 11:28

Behaviour: Humans remains the initial selection. Choosing Agents switches the existing filtered list; selecting the current tab is a no-op. Existing detail clearing and empty/loading/error states remain unchanged. Use the established app tab presentation instead of circular tinted buttons, preserving localized accessible names, tooltips and selected state.

Scope: ContactKindTabs and focused regression fixtures/tests, with a relevant PORTING note. No backend, contact data or shared-control redesign.

Decisions: Keep icon-only tabs and native nsh/base Tabs/Tab for roving keyboard navigation. Reuse the shared SagRule hairline, ink/muted icon colors and moving active dip. Keep desktop 38pt and mobile 44pt press targets; do not invent counts or add width-heavy labels.

Checking: Cover geometry and active switching at desktop 1280pt and mobile 390/320pt, current-tab no-op and keyboard navigation; retain contacts integration coverage. Run nsh check, the required parallel Console scripts/test.sh, and configured gofmt/vet/test with an absolute throwaway HOME. Check visual presentation where available.

## factory · 2026-11-15 11:28

Built and pushed commit 47347144: replaced circular fills with the established hairline/sag tab style. Native keyboard operation, localized tooltips, selected/idle test IDs and filtering behaviour remain intact. Hairline extends 8pt past each end so its dip is not clipped; focus ring is a rounded 36pt square. Added narrow/mobile/desktop geometry, active-switching and keyboard regressions. No installs, dependency manifest or config changes.

Checks: nsh check passed. Required full Console runner: 118 files, zero failures after its automatic isolated retry of chat-attachments.test.tsx. Final 8pt-overhang adjustment was followed by a passing focused rerun of five contacts test files. Configured test `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed, independently repeated by the manager. Scripted tests used throwaway HOME.

Visual inspection: coder checked a throwaway component showcase in headless Chrome (desktop/phone, both selections, keyboard focus and ArrowRight). Not checked: full Contacts page in a running Console, real phone/Android, desktop app or dark scheme. Headless geometry cannot directly read icon tint or rendered hairline; constants and computed dip position provide regression assertions.

Push credential helper initially required a repository path; retry with command-local credential.useHttpPath=true succeeded. No persistent credential configuration changed.
