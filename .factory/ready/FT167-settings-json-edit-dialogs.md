---
branch: factory/FT167-settings-json-edit-dialogs
round: 1
---
# Edit raw JSON settings in dialogs instead of inline textareas

## factory · 2026-11-20 11:55
The owner requested this item in new/: “For all the settings which ask the user to provide raw json, like openai options, cloudflare options, do not just put a textarea to the panel, change to a row with an icon edit button at the row's right. Clicking the button, open a dialog to edit the json.”

### Scope and behavior
- Audit Console Settings for every field requiring users to enter raw JSON, including OpenAI options and Cloudflare options; apply the same interaction consistently to all such fields.
- Replace each inline JSON textarea with a compact, labeled settings row and an edit icon button aligned to its right. Preserve helpful descriptions and provide an accessible name for the icon button.
- Clicking edit opens a dialog containing the JSON editor initialized with the field's current value. Use existing dialog and settings components; keep the layout usable on desktop and mobile.
- Keep edits as a draft until explicitly confirmed. Cancel or dismissal must not alter the setting. Confirmation applies the value through the existing settings save flow; preserve existing defaults, empty-value semantics, read-only/disabled behavior, and persistence contracts.
- Validate JSON and any existing field-specific requirements before applying, show useful errors inside the dialog, and retain the draft after validation failure. Do not change the underlying JSON schema or expose sensitive values in row summaries.

### Acceptance and checks
- No raw-JSON settings editor remains as an inline textarea in a Settings panel; regular non-JSON textareas remain unchanged.
- Each applicable row opens the correct editor and supports confirming valid changes and cancelling without changes, including empty/unset values where supported.
- Add regression coverage for the affected settings, malformed JSON, draft isolation, and existing save behavior. Verify dialog keyboard/focus behavior and mobile layout; report any visual checks not performed.


## factory · plan · 2026-11-20 12:16
Behaviour: Replace raw-JSON textareas with compact labeled rows and accessible right-aligned edit icons without displaying sensitive values. Open an isolated copy of the current value in the existing settings dialog. Cancel, dismissal and Escape discard it; reopening starts fresh. Apply validates JSON and field requirements, retaining draft and error on failure; success changes only the existing parent form draft. Preserve parent persistence, unset/default semantics and disabled controls.

Scope: Shared JSON edit control; generic JSON config fields, raw-JSON row fallbacks, auth-profile advanced bindings and LLM headers. Preserve non-JSON textareas, backend schemas and config keys.

Decisions: Reuse SettingDialog and mobile sheet behavior, not new modal infrastructure. Distinguish Apply from parent Save. Match current config empty-value rejection; auth bindings accept empty as an empty object; LLM headers accept empty as no headers. Validate object-shaped fields without changing backend schemas.

Checking: Cover initialization, cancel/dismiss/reopen draft isolation, malformed/empty JSON, field constraints, disabled controls, rows fallback and parent save. Run nsh check and required parallel Console test script, plus gofmt, go vet and go test. Inspect desktop/mobile fixture keyboard and layout; document unverified platforms.

## factory · 2026-11-20 12:16
Built and pushed commits 79d0d1f7 and 91e6c152. Added SettingJson and integrated every identified Settings raw-JSON editor: generic config options (including OpenAI, Gemini and Cloudflare), rows fallback, auth advanced bindings and LLM HTTP headers. Rows expose no raw values; dialogs isolate drafts and validate before applying through the existing form save flow. Added localized Apply/edit labels and retained ordinary textareas.

Decisions: Config JSON rejects empty as its prior save validation did; unset displays null. Auth bindings require an object (empty means empty object), refusing null/arrays/scalars. LLM headers retain empty-as-no-headers. Apply only updates parent draft. Existing SettingDialog defaults remain unchanged for other consumers.

Installs: none; no manifest or lockfile changes.

Checks: nsh check (0.6.0) and nsh build passed; required scripts/test.sh passed 150 files, zero failures; core Node tests passed 282. New dialog tests (13) and Settings-page persistence tests (2), with an auth test updated. Manager independently reran required gofmt check, go vet ./... and go test ./... successfully and verified commits are item-scoped with no forbidden paths changed.

Visual/keyboard checks: Coder checked desktop 1100×900 and touch 390×844 fixtures in Chrome using available web runtime 0.5.1 (not 0.6), including field focus, one-Escape close, backdrop dismissal and Tab/Enter opening. Actual full Console Settings page was not visually inspected. Desktop app and Android/iOS devices were not run. Focus after close currently lands on the page body rather than returning to the edit button; left unchanged and flagged for review. Headless tests do not directly drive desktop backdrop dismissal or Escape from a focused field; those were fixture browser checks only.

Moved new/ → review/, round 1. Owner/reviewer should inspect dialog focus restoration and full-page visual integration.

## factory · review · 2026-11-20 12:30
head: 91e6c152bf716359f0ad44df24d32bcb52addf6e
verdict: pass
notes:
- [P2] web/console-nsh/components/settings/SettingJson.tsx:80-81: Disabled JSON rows cannot open the dialog and display no value, so previously readable disabled settings become hidden. Example: Cloudflare options {"steps":4} with editable=false/runtime_override is readable in the base disabled textarea but unavailable on this head. Allow view-only opening while keeping Apply disabled.
- [P3] web/console-nsh/components/settings/SettingJson.tsx:26: Whitespace-only drafts pass empty-allowed dialog validation but fail parent Save parsing. Example: one space in auth bindings closes successfully on Apply, then Save reports "Bindings must be valid JSON." Normalize accepted whitespace to an empty string or reject it before closing.

Review scope: origin/master...HEAD, all 12 changed files and relevant callers, request and plan. No P0/P1 findings; passes the factory threshold, with the above nonblocking defects retained for the owner.

Validation by Claude Code: required gofmt check, go vet ./... and go test ./... passed (166 packages); nsh check 0.6.0 passed; required Console scripts/test.sh passed 150 files, zero final failures. Three files needed the script's solo retry: settings-agent-name-set, settings-page-sections and settings-json-page. Verified disabled-value regression against scratch base/head fixtures and auth whitespace Apply/Save behavior. Worktree remained clean; no commits or installs, no manifest/lockfile changes.

Residual risks: full Settings page, desktop app and physical mobile devices not visually checked; mobile software keyboard layout unverified. Keyboard-trigger focus restoration not verified in a real browser and not reported as an introduced defect. Focused-field Escape and desktop backdrop rely on builder's earlier 0.5.1 runtime fixture check. Core Node and Android JVM suites not rerun in this review.

Moved review/ → ready/. Owner should inspect the P2 read-only visibility regression and P3 whitespace validation discrepancy before shipping.
