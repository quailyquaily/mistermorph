---
branch: factory/FT126-contacts-tabs-match-topics-topbar
round: 1
---
# Contacts top tabs: match Topics topbar styling and alignment

## factory · 2026-11-15 14:02

Owner request:
> These 2 buttons tabs at the contacts page top should follow the style at the topics page top: height, circle selected, the bottom edge align with the topbar bottom.
> Add to new/

Follow-up to shipped FT125 (Agent/Human tab styling). Keep FT125 in done/; this item tracks the remaining visual mismatch.

Acceptance criteria:
- Use the Topics page top tabs as the visual reference for the Contacts page Agent/Human tabs, rather than introducing a new tab style.
- Match tab height and the circular selected-state treatment shown on Topics.
- Align the bottom edge of the Contacts tab strip with the bottom edge of the topbar; remove any unintended gap or vertical offset.
- Verify both selected states on mobile and desktop, including narrow viewports, without clipping or overflow.
- Preserve filtering, labels/tooltips, keyboard navigation and accessible selected-state semantics.
- Add regression coverage for tab geometry and selected-state presentation, and visually compare the full Contacts and Topics topbars.

Scope: record this UI bug for implementation; no implementation in this intake request.

## factory · plan · 2026-11-15 14:35

Behaviour:
- The Contacts Human/Agent selector follows the actual Topics topbar reference: same visual height, selected circular treatment, and bottom-edge alignment, with neither selected state clipped at narrow mobile or desktop widths.
- Switching tabs continues to filter contacts and dismiss mismatched detail/edit panels. Empty/loading/error states do not change topbar geometry. First load still selects humans.
- Labels, tooltips, accessible tab/selected semantics, roving keyboard navigation and touch targets remain intact.
Scope:
- Adjust ContactKindTabs and its IndexColumn/topbar integration as needed, using existing Topics/shared controls as the visual reference. Add full-topbar geometry/presentation regression tests rather than testing only an isolated tab strip.
- No unrelated page redesign, data/filter changes, global tab restyling, or changes to FT125/done items.
Decisions:
- The owner explicitly requests circular selected styling; inspect the real Topics header (not merely a generic Tabs helper) and use that as the reference. Reuse existing styling/geometry where possible; do not sacrifice nsh/base keyboard semantics for convenience.
- Keep the established human-first order and 44pt mobile press targets; align the drawn tabs/topbar without shrinking those targets. Record any reference ambiguity and the chosen concrete rendering.
Checking:
- Cover both selections and full Contacts versus Topics topbars on desktop, mobile and narrow widths, asserting tab height, selection presentation, bottom alignment, and bounds/no overflow.
- Preserve keyboard, accessibility and filtering regression tests. Run nsh check and scripts/test.sh per repository requirements and the configured Go gate with an absolute throwaway HOME.
- Visually compare complete headers where tooling permits; explicitly report any unviewed UI/platforms, never claim screenshots were inspected without doing so.

## factory · 2026-11-15 14:35

Built in a524564b; new/ → review/ (round 1).

- Matched the actual Topics ViewToggle: 38pt round buttons, 16pt icons and blue/12 selected fill. Aligned the selected dip with the 57pt topbar bottom through an optional IndexColumn sag. Preserved nsh/base tab semantics, roving keyboard focus, tooltips, human-first order and filtering.
- Mobile retains 44pt press targets around 38pt circles, with 6pt circle spacing to avoid overlapping targets. The strip extends 3pt into the gutter to match Topics' last-circle position.
- Added full Contacts/Topics topbar geometry coverage at 1280, 1024, 390 and 320pt, both selections, resize and Android geometry; covered loading, empty, failure and selection states on the real Contacts page.
- Tests: configured gofmt/vet/go-test gate passed for coder and manager; nsh 0.5.0 check passed; required scripts/test.sh passed (123 files, zero failures after its automatic isolated retry of chat-attachments.test.tsx). git diff --check passed.
- Visual inspection reported by coder: complete Contacts and Topics headers in headless Chrome at desktop 1280pt and touch 390/320pt, both Contacts selections, idle hover and keyboard focus. Checked circle fill/size, hairline y and accessible selected state.
- Not checked: real Android/GPUI applications, dark scheme, Contacts scrolled straight hairline, or frame-by-frame dip animation. Contacts scroll is not reported to this header, so its straight hairline remains transparent; selected dip is drawn. Selected-hover tint is 0.10 rather than selected 0.12; Topics hover parity not inspected.
- Installs: none. Existing pinned toolchain and existing browser tooling reused.
- Initial branch push lacked credential repository path; the single retry with command-local credential.useHttpPath=true succeeded. No base branch or tags pushed.

## factory · review · 2026-11-15 14:52
head: a524564b718b1533458dd84d71b74ae4a728d0ec
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD; no qualifying findings, including no P0/P1. Branch merges cleanly with the fetched master.
- Validation passed: configured gofmt/vet/go-test gate; nsh 0.5.0 check; required scripts/test.sh (123 files, zero failures, 208s); throwaway-output nsh build without unknown-class warnings. Scripted runs used an absolute throwaway HOME. chat-voice.test.tsx failed once concurrently and passed the required isolated retry; not checked on base.
- Reviewed keyboard/filtering/accessibility, 44pt mobile targets, optional IndexColumn sag compatibility, style variants and position-only header resize behavior. A temporary probe confirmed the dip tracks a position-only move and was removed. Tracked worktree remains unchanged; no code commits.
- Installs: no unpinned tools or dependencies; nsh restored its pinned TypeScript 7.0.2 cache.
- Review did not visually inspect a browser, Android or GPUI; visual evidence remains the build's reported Chrome comparison. Dark scheme, selected-hover parity and frame-by-frame dip animation remain unchecked.
- Owner attention: Contacts scroll={false} leaves its straight header hairline transparent (selected dip remains); matches Topics at list top, but scrolled presentation is unverified. Resize fixture's parent-relative tab coordinates do not update on every position-only move, so that regression test is weaker than the independent probe.
- review/ → ready/. No linked GitHub issue or PR in this item.

## factory · 2026-11-15 16:59
Shipped to master using Claude Code. Merge: 73a47e404969f78a8ac65154e824f3645ffe6876. Tag: v0.3.111; master and annotated tag pushed atomically. ready/ → done/.
Final gates passed: gofmt, go vet ./..., go test ./... (163 packages); nsh check; required parallel Console runner (125 files, 1092 tests, zero failures and no retries); Node tests 274/274. No conflicts, integration fixes or unpinned installs. No visual/device checks or platform builds during ship. No linked issue/PR; branch retained (clean not configured).
