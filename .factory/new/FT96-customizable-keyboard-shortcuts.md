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
