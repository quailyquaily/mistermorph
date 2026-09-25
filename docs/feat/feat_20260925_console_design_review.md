---
date: 2026-09-25
title: Console design review
status: proposed
---

# Console design review

A page-by-page review of the Web Console against its visual baseline, with a prioritized list of fixes. Nothing in this document is implemented yet unless marked as done.

## 1. Scope and method

Reviewed every route at 1440×900 and 390×844 against a live console:

- Overview, Contacts (list and detail), TODO (list, editor, calendar), Stats, Audit (All Logs, Tasks)
- Settings: Persona, LLM Config, Tools, MCP, Skills, Channels, Managed Runtimes, Security, Automation, System, Remote Control, Runtime, Credits
- Setup, Troubleshooting (redirects to the ready state when nothing needs repair), Agent Desk (empty state only)

Already reworked in this round and excluded from the findings below:

| Page | Commit |
| --- | --- |
| Logs | `7e1905c4`, `6d4f5f23` |
| Login | `1d5c2ce5` |
| Chat, attachments, web artifact card | `9913580b` |
| Web artifact preview CSP | `0bfbdd15` |

## 2. Visual baseline

The console reads as a drafting sheet or instrument panel. New and revised UI should follow this:

- Faint drafting grid on the page background. Panels are hairline frames with L-shaped registration marks on opposite corners (`QCard variant="default"` or the equivalent pseudo-elements).
- Near-square corners: 2px on panels, 0–2px on controls. No drop shadows, no blur, no rounded pill cards.
- A restrained, cool palette: ink navy for text, steel blue (`--q-c-blue`, `#426f9e`) for accent and selection, muted red (`--q-c-red`, `#a84b5f`) for errors. Colour is used rarely and on purpose.
- Labels are mono, uppercase and tracked (`letter-spacing: 0.12em`, 11px). IDs, times and numbers are mono with tabular figures.
- Status and selection use square marks and bracket labels (`[ WARN ]`), not round dots and pills.
- The quietest item in a list should look quiet. Colour goes to the states that need attention (warn, error, pending), not to the common case.

Colour tokens: the shared `base.css` tokens (`--line`, `--text-*`, `--accent-1`, …) resolve under the active theme since G1. Use Quail variables directly only when a page needs a value the shared tokens don't cover, such as the lighter card hairline `--q-card-border-color`.

## 3. Cross-page findings

These have the widest effect and should come first.

| ID | Priority | Issue | Proposal |
| --- | --- | --- | --- |
| G1 | High | **Done.** `base.css` declared `--line`, `--line-soft`, `--text-*`, `--bg-*`, `--accent-*`, `--ok` and `--danger` on `:root`. The morph theme sets its Quail variables on `body`, so these tokens resolved against Quail's default warm palette (brown-tinted lines and grey text, bright `#0d75fc` accent). | The colour tokens are now also declared on `body`, so they resolve under the active theme. Font and size tokens stay on `:root` only (morph does not override them). See §7. |
| G2 | High | **Done.** Status indicators used four styles: round blue dots (Runtime "Healthy", channel "Running"), round green dots (Contacts "Active", agent switcher, Agent Desk tabs), square green marks (Remote Control "Online"), and square blue marks that meant "selected" in sidebars but "enabled" in the TODO list. | One vocabulary: square marks; filled green = on, hollow grey = off or unknown, orange = pending or stale, red = error. Blue is reserved for selection. See §7. |
| G3 | High | **Done.** Audit task rows carried a filled `[ Done ]` badge on every row, and events a filled `[ Allow ]` / `[ Approved ]`: the routine state was the loudest element. | Three levels. Quiet (outlined grey): done, queued, canceled, allow, approved. Notable (outlined, coloured): running, allow with redaction. Alert (filled): pending, require approval, failed, deny, denied. See §7. |
| G4 | Medium | **Done.** Full locale timestamps (`9/25/2026, 12:45:16 AM`) in Audit, Contacts, Runtime and Stats. | Compact mono times: time only for today, month/day and time within the year, date only for older values; full timestamp in the tooltip where the row has room. See §7. |
| G5 | Medium | **Done.** Settings had a Save button per section, per LLM profile, per Channels card and per config panel; the disabled Save looked almost enabled. | One save bar per section, pinned to the bottom while the section has unsaved changes: count, what is pending, one Save, one combined result. Leaving a section with unsaved changes asks first. See §7. |
| G6 | Medium | **Done.** Toggle placement varied (right-aligned in most sections, under the label in Automation and System); the TODO editor switch had no label. | Config panel switches use the Settings toggle row (text left, switch right, "Restart required" as a mono note). The TODO switch has a visible "Enabled" label. |
| G7 | Medium | **Done.** Guard details stayed editable with Enable Guard off; Heartbeat interval stayed editable with Heartbeat off. | Dependent fields and groups are dimmed and disabled with a note while their parent switch is off in the current draft. |
| G8 | Low | Names don't line up: the nav says "Stats" and the page title is "LLM Usage"; Audit has an "All Logs" view that is easy to confuse with the Logs page; TODO has no page title, only the List/Calendar tabs. | Use one name per page in nav and title. Rename Audit's "All Logs" (for example "All events"). Give TODO a title row like the other pages. |
| G9 | Low | The phone bottom nav is a floating rounded pill with a drop shadow, the one strongly off-style element left on phones. | Square, hairline-framed bar docked to the bottom edge, with the selected item marked the way the sidebar marks it. |

## 4. Per-page findings

### Stats

- The per-model table's right-hand column group is clipped (the header shows "TOK…") with no hint that it scrolls. Add a visible scroll affordance or let the table wrap into two groups on narrower widths.
- Costs are shown to six decimals (`$0.025872`). Use two to four significant decimals, with the full value in a tooltip.
- Cache savings appear as a green negative number (`-$0.0047`), which reads ambiguously. Label it as savings with a positive number, or name the column so the sign is clear.

### Audit

- Task rows are about 75px tall and many titles repeat ("hi"). A single-line row (title, mono time, quiet status) would fit about twice as many.
- On phones the "Tasks" item is indented differently from the other sidebar items.
- The Runtime design doc (`feat_20260909_runtime_page_design.md`, "走查后调整") says manual refresh buttons were removed from Audit, but `AuditView.js` still renders them (lines 951 and 1012). See §6, D2.

### Contacts

- The detail card is short and leaves most of the screen empty.
- List rows are two lines tall.
- "Unnamed User" appears three times. When there is no name, use the channel identifier as the title and keep "Unnamed" as a quiet note.

### TODO

- Calendar entries are truncated to "Test Ever…", which adds nothing. Show the title only and move the schedule text to the tooltip or day panel.
- The "today" marker is a filled circle; use a square mark to match the rest of the console.
- The day panel on the right is mostly empty for days without items.
- The editor's content area is very tall for a one-line prompt. Size it to content with a sensible minimum.

### Settings: System

- "Logout" is a solid, saturated red button, the loudest element in Settings, and not the theme's muted red. Use an outlined button with muted red text; keep confirmation if it exists.
- The Language row puts the label beside the control while the rest of Settings puts labels above. Pick one layout for form rows.

### Settings: Channels

- Placeholder IDs (`123456789`, `-1001234567890`) are dark enough to be mistaken for real values. Lighten them and prefix with "e.g.".
- Keep the hatched env-managed token fields; they fit the baseline well.

### Settings: Runtime

- Values in the key/value tables (`44.6 MiB`, `63`, `210`) use the sans font. Use mono with tabular figures, as elsewhere.

### Settings: MCP

- A server row shows only its name and command ("node"), with no connection status or tool count.

### Overview

- The agent tree is small in the middle of a large empty page and has no title.
- On phones the dashed connector to "Add Agent" routes awkwardly from the far left.

### Setup

- On phones the sheet touches the screen edges and the top-left registration mark is clipped. Add the standard side gutter.
- The finished screen still labels a step "CREATE IDENTITY.YAML". Use a noun label in the done state ("IDENTITY.YAML").

## 5. Suggested order

1. G1: the `base.css` token fix. Done, see §7.
2. G2–G4: done, see §7.
3. G5–G7: done, see §7.
4. Stats table, then the remaining per-page items.

Each step should be checked at 1440 and 390 widths, with screenshots of every page it touches.

## 6. Open decisions

- **D1. Colour for normal status. Resolved (2026-09-25):** green for every "on" status, blue only for selection. Blue had been doing both jobs: the same blue square meant "selected" in the Settings and Audit sidebars and "enabled" in the TODO list. Morph's green (`#3f6d6e`) is a muted teal that fits the palette. This supersedes "正常状态使用 Morph 蓝色" in `feat_20260909_runtime_page_design.md`. To revisit, change `--status-on` in `base.css`.
- **D2. Audit refresh buttons. Resolved (2026-09-25):** removed to match the Runtime design doc. Audit refreshes the latest page every 15 seconds (skipped while an entry is expanded or the tab is hidden) and retries a failed file list the same way. "Latest", which jumps back to page 1, stays.
- **D3. Settings save model. Resolved (2026-09-25):** one save bar per section, no save-on-change. It keeps a single, predictable save behaviour and lets several "Restart required" changes go out together.

## 7. Implementation notes

### G1: colour tokens (2026-09-25)

- `web/console/src/styles/base.css`: the colour tokens are declared on `body` in addition to `:root`. Custom properties resolve where they are declared, and Quail puts `data-theme` and the theme's `--q-*` variables on `body`, so declaring them there picks up morph. Content teleported to `body` (dialogs, fullscreen previews) is covered too.
- `web/console/src/views/ChatView.css`: removed the `.chat-shell` copy of the same token block, which is now redundant.
- `LogsView.css` and `LoginView.css` keep their own `--logs-*` / `--login-*` tokens. They are deliberate page tokens (for example, the sheet uses the lighter `--q-card-border-color` rather than `--line`), not workarounds; only their comments changed.
- `web/console/src/views/RuntimeView.css`: the inactive status dot used `--text-1`. Under morph that token is dark navy, which made "Not running" darker than "Running" (steel blue). The inactive dot now uses a faded `--text-2`.
- Checked by comparing screenshots of every page before and after at 1440 and 390 widths, and by reading the computed tokens on a page element (`--text-2` `#5f7894`, `--line` from `#a5bad0`, `--accent-1` `#426f9e`). Stats is nearly unchanged because its `--stats-*` tokens already mixed in the accent; revisit them with G2.

### G2: status marks (2026-09-25)

- `web/console/src/styles/base.css`: shared tokens in the `body` token block: `--status-mark-size` (7px), `--status-on` (green), `--status-off` (faded grey), `--status-pending` (orange), `--status-error` (red). Quail's default `QBadge dot` is drawn hollow, since "default" means off or unknown here.
- Square marks (1–2px radius) using those tokens in:
  - `RuntimeView.css`: health and channel status
  - `ContactsView.css`: "Active"
  - `SettingsView.css`: LLM profile "Available" / "In use"
  - `AgentSwitcher.css`, `AppMobileBottomNav.css`: agent online/offline
  - `AgentDeskView.css`: tab status, plus the prefix marker
  - `AgentChatPane.css`: avatar status and the unavailable mark
  - `OverviewView.css`: avatar status, with pending shown dashed
- `TodoView.js`: enabled items use the `success` dot instead of `primary`, so the TODO list no longer reuses the selection colour.
- Unchanged on purpose: avatars stay round; the chat progress panel keeps its square terminal-palette dots on the dark background; Remote Control's QBadge dots already matched (success / danger / default); sidebar selection markers stay blue.
- Checked with close-up screenshots of every indicator above (on and off states where the data had both).

### G3: attention-weighted badges (2026-09-25)

- `web/console/src/views/AuditView.js`: `auditBadge(level, type)` returns QBadge props for three levels (quiet, notable, alert). `decisionBadge`, `approvalBadge` and `taskStatusBadge` map each state to a level; the templates bind them with `v-bind`. The risk text (`Risk · Low`) is unchanged.
- `web/console/src/core/audit-view.test.mjs`: the approval test now asserts the new contract (approved renders quiet; the original `require_approval` decision still renders as an alert) instead of `approvalType: "success"`.

### G4: compact timestamps (2026-09-25)

- `web/console/src/core/time-format.js`: `formatShortTimestamp(ts, locale, now)`, a pure formatter with tests in `time-format.test.mjs` (structural assertions, since month abbreviations differ between ICU versions). `core/context.js` exposes it as `formatShortTime` using the current locale.
- Used for list rows and "updated" lines: Audit event and task rows (mono, full time in the tooltip), Audit archive subtitles and "Updated", Runtime "Updated" / "Started" / "Last Poke", Contacts activity times (under the relative time), Stats "updated", Logs "Updated".
- `formatTime` (full locale timestamp) stays for tooltips and places where the full value is the point: auth flow expiry messages, Setup, Settings.
- `audit-view.test.mjs` stubs `formatShortTime` alongside `formatTime`, since it runs the view with injected dependencies.
- Checked with screenshots of Audit (All Logs, Approvals, Tasks), Runtime, Contacts and Stats.

### D2: Audit refresh buttons (2026-09-25)

- `web/console/src/views/AuditView.js`: removed the header refresh button and the mobile sidebar one. `refreshAudit` stays (the 15-second timer and tests use it).

### G6 and G7: toggles and dependent settings (2026-09-25)

- `web/console/src/components/ConfigSettingsPanel.js`:
  - Bool fields render as the Settings toggle row, with "Restart required" as a mono note under the label.
  - A field with `dependsOn` (a bool path in the same panel) is disabled and dimmed, with "Turn on … to change this", while that switch is off in the draft.
  - `inactiveGroups` (group id → note) marks whole groups as read-only.
- `web/console/src/core/config-field-groups.js`: `heartbeat.interval` depends on `heartbeat.enabled`.
- `web/console/src/views/SettingsView.js`: Guard details (`guard-storage`) is inactive while Enable Guard is off, with a translated note.
- `web/console/src/views/TodoView.js`: the editor switch shows an "Enabled" label.

### G5: section save bar (2026-09-25)

- **Save units per section** (`sectionSaveUnits` in `SettingsView.js`):
  - Draft scopes: Persona; LLM Config and each profile; Tools; Skills; Managed Runtimes; Channels; Guard.
  - Config panels register through `provide("settingsSaveRegistry")` when given `saveScope`, and then hide their own Save button.
  - Not covered: MCP servers, auth profiles and Remote Control endpoints keep their own add/edit dialogs (collections, not drafts); the advanced settings dialog keeps its dialog Save.
- **Save order:**
  1. Every panel's update is collected first (`collectUpdate`) and merged per endpoint (`mergeConfigUpdates`). A save response replaces the shared config values, which would otherwise reset panels not yet sent.
  2. Then the draft scopes are saved; all dirty console targets of a section go out in one `PUT /settings/console`.
  3. Then the merged panel updates go out, one request per endpoint.
  4. Saving stops at the first failure and the bar shows what was not saved.
  5. One toast reports the strongest outcome (restart beats plain save).
- **Data-loss fix:** a console save response rewrites every console scope, so saving one Channels card discarded unsaved edits in the others. `applyConsolePayload(payload, { savedScopes })` now captures dirty scopes outside the save and restores them (`captureUnsavedScopes` / `restoreUnsavedScopes`), secret markers included. Loads still replace everything.
- **Leaving a section:** switching sections already discarded all drafts (`discardSettingsDrafts`). `onBeforeRouteUpdate` / `onBeforeRouteLeave` now ask first ("Keep editing" / "Discard changes"). `selectSection` navigates before selecting, so a cancelled navigation leaves the current section on screen.
- **Save functions:** `savePersona`, `saveAgentSettings`, `saveLLMProfile`, `saveConsoleSettings` and `saveConfigSettings` take `{ notify }`, return `true`/`false`, and record `apply_mode`. `saveConsoleSettings` accepts several targets.
- **Tests:**
  - `core/settings-save.test.mjs` covers keeping unsaved scopes and merging updates.
  - `settings-channels.test.mjs` and `settings-save-notices.test.mjs` are source-pattern tests; they now assert the new wiring (channel targets, the combined toast) instead of the removed per-card buttons.
- **Checks:** end-to-end with every settings `PUT` intercepted and answered with the current server state, so nothing was written:
  - Two Channels edits went out as one request.
  - The Automation panel sent exactly its two changes.
  - The leave dialog blocked navigation, and "Keep editing" / "Discard changes" behaved as labelled.
  - LLM Config has no card-level Save left.
  - The bar lines up with the section cards at 1440 and sits above the bottom nav at 390.
- **Known limits:**
  - Quail text areas update their value when they lose focus, so the bar can lag one field behind while typing. The change is still included when Save is pressed, since pressing it moves focus.
  - The dialog's "Discard changes" uses Quail's saturated `danger` button, the same issue as "Logout" (see §4, Settings: System).
