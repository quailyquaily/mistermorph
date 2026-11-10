---
branch: factory/FT59-console-mobile-column-two-list-font-size
round: 1
---
# Increase mobile column-two list item font size

## factory · 2026-11-10 08:56
Requested by the owner in Console.

Increase the font size of column 2’s list items on mobile for better readability, consistent with the existing design. Cover topic and contacts lists and other list items sharing this column’s styling. Choose a modest increase using the existing typography conventions; preserve secondary-text hierarchy, touch targets, truncation, and layout without overlap. Keep desktop typography unchanged.

Registered in new; not diagnosed or implemented.

## factory · plan · 2026-11-10 11:14
Behaviour: Increase mobile column-two primary list titles modestly; retain smaller secondary labels, touch targets and truncation. Empty, loading, error and first-run displays remain unchanged; desktop typography stays unchanged.
Scope: Topics and shared index rows (Contacts, Memories, Skills), plus the equivalent TODO list; mobile text styling and focused tests only. No global typography or detail/composer changes.
Decisions: Use the existing mobile breakpoint and 15px title convention rather than 14px; grow line heights proportionately, with the existing 15/22 pairing for topics.
Checking: Test real pages at desktop and phone widths, long-label truncation and touch targets; run the configured Go gate and nsh checks/tests. Inspect narrow layout when available.

## factory · 2026-11-10 11:14
Built in 75cb5c02. Added shared listTitleSize and applied mobile 15px titles to Topics, Contacts, Memories, Skills and TODO. Desktop remains 14px. Secondary text, group labels, targets and truncation are preserved.
Tests: Manager independently passed the configured gofmt/vet/go test gate. Claude Code passed nsh check and the full nsh suite (414 passed, 0 failed on rerun). The first full suite had a transient Settings input-editability failure; that file passed alone and the complete rerun passed. Reverting the font size temporarily made all three phone font-size regressions fail as expected.
Visual checking: Claude Code inspected temporary real-row fixture screenshots at 320px, 390px and desktop width, with no overlap. The real console with live data, Android device/emulator and native desktop window were not checked.
Installs: none.
Moved new/ → review/; ready for independent review, not merged.

## factory · review · 2026-11-10 11:48
head: 75cb5c0265e04d03723d9ca4ff73116ad4e22ccc
verdict: pass

Codex reviewed all six changed files in origin/master...HEAD; no qualifying findings. Branch merges cleanly with origin/master.
Validation: configured gofmt/vet/go test gate passed (162 tested packages); nsh check passed; nsh tests passed (414 passed, 0 failed). Tests used a throwaway HOME. No installs or tracked-file changes.
Residual risks: actual browser rendering, Android devices and native desktop windows were not inspected in this review. Owner should check mobile list readability and truncation on real screens.
Moved review/ → ready/; not merged.
