---
branch: factory/FT96-customizable-keyboard-shortcuts
round: 1
---
# Customizable keyboard shortcuts with web and desktop defaults

## factory · 2026-11-11 21:02
Owner request:
> customize keyboard shortcuts, include good default binding, and UI to customize.
> the web version and the desktop version may use slight different bindings because in the browser env, many good keyboard shortcuts bindings are not available.

Requirements and acceptance criteria:
- Provide a discoverable keyboard-shortcut settings UI listing supported actions and their effective bindings; allow recording/rebinding, clearing an individual binding, and restoring defaults.
- Ship useful defaults for existing Console actions. Define and document the supported action list during implementation rather than introducing unrelated features.
- Use separate web and desktop default profiles where necessary, with OS-appropriate modifier labels and conventions. Browser defaults must avoid known browser-reserved shortcuts; do not promise interception of combinations the browser or OS owns.
- Warn about known unavailable/reserved combinations in the active environment and detect conflicting app bindings before saving. Explain how to resolve conflicts rather than silently letting one action win.
- Persist customization across reloads/restarts, keeping environment-specific overrides separate so a desktop customization does not accidentally break the web profile.
- Respect focus, editable fields, IME composition, dialogs, and action availability. Ordinary typing and existing editor shortcuts must remain intact; each shortcut fires at most once per intended activation.
- Show effective bindings in relevant shortcut help/tooltips where available, and make customization usable with the keyboard, including cancellation and accessible labels.
- Cover default selection by environment/OS, rebinding and persistence, clearing/resetting, conflict handling, and focus/IME safeguards with regression tests. Explicitly report which browser and desktop interactions were verified manually and which were not.

Scope: application keyboard shortcuts, not global OS-wide hotkeys. Exact defaults should be chosen after inspecting existing actions and host constraints; no implementation or release is requested by this intake entry.

## factory · plan · 2026-11-11 21:57

### Behaviour
Discoverable keyboard shortcut settings list actions and effective bindings; record, cancel, rebind, clear and reset with reserved-key and conflict validation. Persist environment-specific overrides with safe missing/corrupt-data defaults. Dispatch once while respecting focus, editors, IME, dialogs and action availability.

### Scope
Shared app shortcut registry/dispatcher, settings UI, existing actions and tooltips, documentation and regression tests. No global OS hotkeys or unrelated actions.

### Decisions
Choose a modest existing-action set and OS-appropriate modifiers, conservative browser defaults and separate web/desktop storage. Explicitly disabled differs from default. Conflicts require explicit resolution. No backend configuration changes.

### Checking
Test defaults by environment/OS, persistence, clear/reset, conflicts/reserved keys, cancellation, focus/IME/dialog guards and single activation. Run configured Go gate, nsh check and full nsh tests using throwaway HOME. Record browser and desktop manual-check limitations.

## factory · 2026-11-11 21:57

Built and pushed 8c557752 on factory/FT96-customizable-keyboard-shortcuts. Added 13 existing Console actions, Settings keyboard-shortcut panel, recording/cancellation, remove/reset/restore defaults, reserved-key explanations and explicit Reassign conflict resolution. Added effective tooltips, English documentation and localized UI.

Decisions: web and desktop profiles persist separately; Android uses desktop profile. Corrupt data falls back safely; duplicate stored bindings resolve deterministically and show inactive actions. Browser defaults and exact supported actions are documented in docs/console/keyboard-shortcuts.md. Review should scrutinize browser reservations across actual browsers and native event safeguards.

Installs: none. No dependency or manifest changes.

Tests: configured gofmt/vet/go test gate passed in coder and independent manager verification. Coder reports nsh check and nsh build clean; full nsh tests 667/667 passed, including 21 new shortcut tests. Tests used absolute throwaway HOME. Manager verified item-only commit, clean worktree and no forbidden-path changes.

Manual checks reported by coder: headless Chrome with PC and emulated Mac modifiers, typing safeguards, navigation, tooltips, recording/cancel, reserved keys/conflicts, persistence/reload, dialog blocking, corrupt storage and phone layout. Synthetic IME and repeat checks passed in Chrome. NOT checked: live desktop GPUI (no display), native IME/repeat, real Mac/Windows browsers, real IME, Android hardware keyboard, screen readers, reserved-key reachability across real browsers. These are review/manual validation limitations, not confirmed cross-platform support.

Moved new/ → review/, round 1. No linked issues or PRs. FT96 selected as oldest new item by last-change timestamp; FT93 was newer at selection and handled elsewhere during this run.

## factory · review · 2026-11-12 03:04
head: 6d21246fa958879c9a3499652661ce91bcf743f7
verdict: pass
notes:
- [P3] web/console-nsh/lib/shortcuts.ts:504: RECORD_KEYS omits backslash because its string escapes the semicolon rather than including a literal backslash. Escape the backslash as in CHAR_KEYS. Verified example: after clearing frame.toggleSidebar on desktop Linux, recording Ctrl+backslash never finishes; recorderKeystrokes excludes that binding, while Ctrl+semicolon records successfully. Reset still restores the default.

Reviewed origin/master...HEAD with Claude Code. No P0/P1 findings. Merged origin/master and resolved TopicSidebar.tsx conflict, preserving the touch-drag comment and shortcut InputRef import; merge 6d21246f pushed. No forbidden-path changes in item diff; worktree clean.

Validation: configured gofmt/vet/go test gate passed in both coder and independent manager checks after merging. Review reran the Go gate successfully; nsh check passed; full nsh tests passed (788 tests, zero failures). Installs: none. Review tests used an absolute throwaway HOME within the review directory. Conflict-resolution coder used a throwaway HOME under /tmp rather than the requested run directory; no repository changes resulted from that deviation.

Residual risks: native desktop GPUI, Android hardware keyboard, real cross-platform browsers, IME/repeat, non-US layouts, screen readers and the updated Settings layout were not manually verified. Browser reservations for Ctrl+Shift+O/Ctrl+K/Ctrl+I need real-browser or authoritative-documentation verification; the coder's second suggested P3 lacked that evidence and is retained as uncertainty, not a confirmed finding. Base Sheet/Popover/Select/DatePicker popup suppression and keyboard focus after recording-control changes were not verified.

Moved review/ → ready/. Round 1 of 3. No linked issues or PRs. Owner should inspect the recorder backslash limitation and native/browser validation gaps before shipping.
