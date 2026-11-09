---
branch: factory/FT45-console-mobile-dropdown-sheet-safe-area
round: 1
---
# Mobile dropdown bottom-sheet safe areas

## factory · 2026-11-09 19:10
Owner request: "1. All drop-down, on mobile view, if they show as bottom sheets, the bottom should hold a safe area. For example the composer's plus button and profile selector"

Queue this UI fix in new/.

Acceptance criteria:
- All dropdowns rendered as bottom sheets on mobile reserve bottom safe-area space, including the composer plus menu and profile selector. Audit other dropdown-to-sheet instances, not only these examples.
- Interactive content remains above the home indicator/system gesture area; use the platform safe-area inset rather than a device-specific constant, with normal padding when the inset is zero.
- Apply the rule consistently through shared sheet styling where practical; avoid double-counting existing safe-area padding.
- Preserve scrolling, keyboard-open positioning, dismissal, focus, selection, and desktop dropdown behavior.
- Add regression coverage and visually check mobile sheets with nonzero and zero safe-area insets, keyboard open/closed, and long content. Record any checks that cannot be performed.

## factory · plan · 2026-11-09 20:36
Behaviour: Touch dropdown sheets reserve the platform bottom safe-area inset inside their surface, retaining ordinary padding with zero inset. Keyboard clearance replaces rather than adds to the bottom inset. First opening, empty lists, selection, dismissal and refocus remain unchanged; desktop positioning stays unchanged.

Scope: Audit shared Menu/Select controls and direct call sites, including composer profile selection and dropdown-style DatePicker sheets. Share inset calculation; leave anchored Popovers and unrelated UI alone.

Decisions: Read nsh 0.4.0 behavior before applying padding; use safeArea() rather than device constants. Keep the model picker's keyboard/refocus sequencing. Extend maximum sheet height by reserved clearance without letting content cross the status bar. Ensure long menu rows scroll.

Checking: Cover zero/nonzero insets, touch/desktop, keyboard hidden/shown, small windows and long content. Run formatting, Go vet/tests, nsh check/tests; inspect simulated screenshots and record missing real-device checks.

## factory · 2026-11-09 20:36
Built and pushed acdfc0de and 265ae3a2; head: 265ae3a252156ce0ea9830f794960d07bca3296e.

Added shared bottomSheetInsets/bottomSheetStyle to all audited dropdown-to-sheet controls: DropdownMenu, both SelectField paths, composer profile selector, SettingMenu, TodoSelect, AgentSwitcher, and todo/memories date pickers. Framework sheets did not add their own inset. Keyboard height replaces the bottom inset; ordinary padding is preserved. Wrapped long SelectField menu rows in Scroll to keep the final choices reachable. Added regression fixtures/tests and English PORTING notes.

Manager independently verified with a throwaway HOME: gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js all pass (325/325 console tests). Worktree clean; only item-related commits and no protected paths changed.

Coder reports fixture screenshot checks with zero and 34pt insets, long menu/select content, simulated keyboard and desktop placement, plus automated 16/48pt and iPhone-style inset cases. Full Console UI, real Android/iOS devices and a real software keyboard were not checked; fixture simulations are not device validation.

Installs: no manifest/lockfile changes; existing nsh 0.4.0 and Chrome used. The coder could not establish whether any additional screenshot utility was installed; no confirmed unpinned install to report.

Moved new/ → review/. Owner/reviewer should inspect mobile safe-area clearance, keyboard transition and long-list scrolling on real devices.
