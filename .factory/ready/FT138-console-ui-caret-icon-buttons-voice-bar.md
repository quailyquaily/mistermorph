---
branch: factory/FT138-console-ui-caret-icon-buttons-voice-bar
round: 1
---
# Console UI: no caret on the compact agent switcher, icon-only buttons, rounded voice bar

## factory · 2026-11-16 20:45

Owner request:
> here are some UI issues:
> 1. Agent switcher's compact mode, do not show the caret.
> 2. I don't like button with both label and icon. remove the button with label and icon in ui-component. if in the UI there are button with both label and icon, replace it with icon only.
> 3. the voice bar in the composer should be radius corner as well, just like composer itself.

Scope and acceptance:

1. **Agent switcher, compact mode.** `web/console-nsh/components/frame/AgentSwitcher.tsx` (`compact` prop, used by the collapsed sidebar): in compact mode the trigger shows no caret, also while its popover is open. The full-width switcher keeps its caret.
2. **No button with both a label and an icon.**
   - Remove the label-and-icon button examples from the UI component gallery (`web/console-nsh/pages/ui-components/demos/`), and keep `pages/ui-components/inventory.js`, `docs/console/ui-components.md` and the gallery tests in step.
   - Find every button in the Console that shows a label and an icon together, and make it icon-only. An icon-only button keeps its meaning for people who cannot see the icon: the former label becomes its `accessibilityLabel` and its tooltip.
   - A loading spinner inside a button is its busy state, not an icon; leave it.
   - Menu rows, list rows, tabs, chips and navigation entries are not buttons; leave them.
3. **Voice bar in the composer.** The bar the composer shows while recording voice has the same corner radius as the composer itself, in every place the composer is shown (conversation, landing, mobile).

Checking: `nsh check` and `web/console-nsh/scripts/test.sh` pass, with tests updated where they find a button by its label text; look at `/ui-components` (frame, controls and chat sections) for all three changes.

## factory · plan · 2026-11-16 21:23

Behaviour: the compact agent switcher never renders a caret, including open and empty states; the full-width switcher retains its caret. Genuine icon-and-label buttons become icon-only, with the former localized label as accessible name and tooltip; disabled and busy behaviour is preserved. Text-only buttons, menu/list rows, tabs, chips and navigation are unchanged. The voice recording/transcribing strip matches the composer radius on landing, conversation and mobile.

Scope: shared Button, custom Console button usages, AgentSwitcher, composer voice strip, gallery demos, documentation and regression tests; no backend or unrelated redesign.

Decisions: enforce icon-only glyph faces in the shared Button and audit custom wrappers; keep download platform/build information, checksum and server values as adjacent non-button text. Use the existing 27pt composer radius, not a new radius. A labelled glyph's tooltip uses its label before title. Preserve localization and handlers.

Checking: compact closed/open/empty and full-width caret tests; icon-only name/tooltip/disabled/busy tests; voice radius and landing/conversation/mobile coverage; gallery inventory consistency; nsh check, required parallel Console test.sh and root gofmt/vet/tests. Inspect gallery frame/controls/chat where feasible.

## factory · 2026-11-16 21:23

Built in five focused commits, head: 7e66af83. Compact caret removed; voice strip rounded and clipped using composer radius; shared and custom labelled-icon buttons converted, including release downloads and Logs Follow. Updated gallery demos, docs and regression tests. Inventory entries remain accurate without changes because no components were added or removed; the inventory test now prevents labelled-icon gallery examples.

Decisions: release platform/build names, checksum and login server remain visible as text beside an icon button. Previous label takes tooltip precedence over a longer title; existing longer Stop and truncated-skill Edit hints are no longer displayed. Menu/list rows, tabs, chips, navigation and non-command select/disclosure triggers remain unchanged.

Installs: none; no manifests or lockfiles changed.

Tests: nsh check passed (repository-pinned nsh 0.5.1). Required Console scripts/test.sh passed: 129 files, zero failures on final run, plus inventory check. Initial chat-attachments parallel failure passed an isolated rerun; final full run needed none. Root gofmt check, go vet ./... and go test ./... passed under throwaway HOME; manager independently repeated the root checks successfully.

Visual checking: gallery inspected in headless Chrome at desktop 1400x1000 and mobile 390x844: button demo/hover tooltip, full and compact switcher, and voice composer demo (27px computed corners, clipping). Not visually checked: compact switcher while open, converted buttons on real pages, real chat voice bar, final release-download and Follow changes. Desktop and Android apps not run. Those states have automated test coverage only.

Push: initial credential-helper request lacked repository-path information; command-local credential.useHttpPath=true resolved it on the allowed retry. Branch pushed successfully.

## factory · review · 2026-11-16 21:54
head: 7e66af8342f80200f3e70801277aac6440d84af7
verdict: pass
notes:
- [P2] web/console-nsh/components/ui.tsx:610: hiding all icon-button labels also hides the memory card source count. Keep the value as adjacent text. Verified example: a memory with source_events: [] visibly showed "No recorded source" on base, but only Edit/Forget on head; its accessibility label remains.
- [P2] web/console-nsh/pages/logs/LogsPage.tsx:516: the existing custom ToolButton was missed by the requested conversion. Make its face icon-only with its label as accessible name and tooltip. Verified example: opening a tool_failed log entry still displays both icons and ONLY THIS EVENT / VIEW RAW LOG labels.
- [P3] web/console-nsh/components/ui.tsx:572: icon plus title without label is no longer square in the converted gallery examples. Apply square sizing to glyph-only faces while preserving intentional children. Verified example: md icon/title Refresh measures 50x44 versus 44x44 with iconOnly; smaller sizes likewise have unequal sides.
- [P3] web/console-nsh/components/ui.tsx:574: label-first tooltips remove unique title information. Preserve the full checksum and truncated-skill disabled-edit explanation as adjacent text or supplementary tooltip content. Verified example: label="Stop" title="Stop this run" is explicitly tested to suppress the latter; the checksum Copy and disabled skill Edit use the same path.

Validation: Claude Code reviewed origin/master...HEAD across all 26 changed files; no P0/P1 findings. Root gofmt/vet/go test ./... passed. nsh check (pinned 0.5.1) passed. Required Console scripts/test.sh passed: 129 files, zero final failures, inventory check passed. chat-topic-drag and chat-voice required isolated retries; both passed, and chat-voice passed three further isolated runs. Tests used throwaway HOME. Installs: none beyond pinned toolchain restoration; no manifest or lockfile changes. Worktree stayed clean at the reviewed head; branch merges cleanly with origin/master.

Residual risks: this review used headless probes, not rendered visual inspection. Open compact switcher, real voice bar corners on landing/conversation/mobile, native desktop/Android tooltips, touch discoverability and phone dialog action-row sizing were not visually verified. Four P2/P3 notes remain for the owner; factory policy permits ready/ without P0/P1. Moved review/ → ready/; not merged or shipped. No linked GitHub issue or PR was present, so no GitHub comment was required.
