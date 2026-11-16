---
branch: factory/FT134-ui-component-testing-gallery
round: 1
---
# UI component gallery for desktop, mobile and locale testing

## factory · 2026-11-16 13:02

Owner request:
> I need a page which lists all UI components, to let me check and review and test.
> It's only for testing, so it only provides a route, no need to provide the entry.
> This page should be good in desktop and mobile view, well arranged, support to switch languages to see the different locale.
> Put this to new/

Requirements and acceptance criteria:
- Add a directly addressable Console testing route, default `/ui-components` unless existing routing conventions require an equivalent; document the actual URL. Do not add an entry to the sidebar, bottom navigation, menus or other normal navigation. Preserve existing authentication/access boundaries.
- Inventory all current Console UI components and provide a clearly grouped, labeled gallery of the actual production components, not visual copies. Include shared controls, navigation/frame elements, cards, chat and composer elements, rich content/attachments, settings/forms, dialogs, sheets, popovers, feedback/status elements and other user-visible components found during implementation. Explain any components that cannot sensibly render standalone and provide a composed fixture where possible; do not silently omit them. Nonvisual utilities do not require individual demos.
- Arrange the page for practical review on desktop and mobile: readable sections, usable spacing, responsive columns, narrow-screen wrapping, accessible controls and contained overflow. Wide components may scroll within their own demo, without making the whole page horizontally overflow. Provide a compact section index or filter to locate components as the inventory grows; it belongs only to the testing page.
- Show representative supported variants and states (default, selected/active, disabled, loading, empty, error, long content, etc., as applicable). Provide working local interactions for controls and overlays so the page supports testing, not just screenshots. Reuse existing styling, themes, transitions and responsive behavior.
- Provide an obvious language selector using the application's existing locale mechanism and every currently supported locale. Switching it updates the gallery UI and localized component examples without navigating away; exercise long translations and interpolation/pluralization where applicable. Do not introduce a second independent translation system.
- Use deterministic, synthetic fixtures and local state. Opening or interacting with demos must not send messages, execute tools, change real settings/data, request privileged approvals or trigger other production side effects. No live agent/service is required for the component fixtures. Preserve normal authentication while isolating demo actions from production APIs.
- Keep this a lightweight testing page within the existing Console, not a new component framework or separate documentation app. Do not change normal pages or add a navigation entry merely to support the gallery.
- Add regression coverage for direct routing, absence of normal navigation entries, inventory/section rendering, language switching, representative interactive states and side-effect isolation. Run the required Console checks and test runner. Visually check a desktop and narrow mobile viewport across supported locales where possible; explicitly record anything not checked.

## factory · plan · 2026-11-16 13:51

Behaviour
- A signed-in user opens /ui-components directly; existing session/setup guards remain intact. No normal navigation entry is added and existing public previews are not repurposed.
- A grouped inventory renders actual production components with synthetic deterministic fixtures, variant labels and local interactive controls. Search/index supports locating components; empty results explain how to reset. Overlays can open/close and error/loading/disabled/empty/long examples are visible where meaningful.
- The existing locale mechanism and selector update both gallery labels and localized examples in place for every supported locale. Fixtures do not call production APIs, mutate settings, send messages or execute tools; locale selection uses only the existing locale mechanism.
- Desktop and narrow screens use bounded, wrapping demo containers; wide examples scroll internally.
Scope
- Add a lightweight Console route/page, fixtures/inventory, English documentation and regression tests. Inventory all user-visible components under components/ and page-local components; render reusable components directly or safe composed fixtures, and explicitly document standalone limitations. Do not substitute visual copies or silently omit components.
- Normal pages, navigation and backend remain unchanged except minimal routing registration. No new framework, live services, or production store mutations for demonstrations.
Decisions
- Use a distinct authenticated /ui-components route, not the existing public /__components stub. Reuse existing production styles and translations, extending the same locale catalog for gallery strings.
- Prefer explicit fixture adapters for components with action callbacks. Stateful components that inherently fetch or mutate live data must not be mounted without safe injection; document limitations and include safe composition where possible.
- Inventory labels include component names for reliable search. Use synthetic long multilingual text and representative locale interpolation already supported; no independent translation system.
Checking
- Add tests for route auth metadata/direct resolution, absence of normal navigation entries, inventory completeness and grouped rendering, search empty/reset, locale switching, local controls/overlays and zero production network/write side effects.
- Run nsh check and scripts/test.sh for Console, plus test -z "$(gofmt -l .)" && go vet ./... && go test ./... from repository root. Scripted tests use an absolute throwaway HOME, retaining necessary tool/module caches through explicit environment variables.
- Attempt real desktop and narrow mobile visual checks across locales with available tooling; report precisely what could not be checked rather than claiming visual coverage from structural tests.

## factory · 2026-11-16 13:51

Built commit: 8f717938 (factory/FT134-ui-component-testing-gallery).
- Added authenticated, shellless /ui-components with no normal navigation entry; public /__components unchanged. Added 16 groups, index/filter/reset, locally interactive production component fixtures, responsive cards, and existing en/zh/ja locale switching. Documentation: docs/console/ui-components.md.
- Inventory: 387 components, 151 direct demos, 72 composed, 164 explicitly not mounted with reasons (16 pages, 93 private children of omitted live panels, 41 live store/API components, 8 router-bound frame components, 5 nonvisual parts, 1 picked-file dialog). Review whether these limitations sufficiently satisfy the requested coverage.
- Installs: none reported; pinned Go modules restored. Reused existing nsh/Playwright tooling.
- Coder reports nsh check/build pass; Console required scripts/test.sh: 126 files, zero failed, plus inventory check; gallery 12 tests pass. Manager independently reran gofmt/vet/go test ./... successfully, nsh check successfully, and all 3 inventory checks successfully. Manager did not rerun the full Console suite.
- Actual Chrome checks with stubbed APIs: desktop 1440x900 and touch 390x844, all 16 sections in en/zh/ja automatically probed, selected screenshots inspected. No whole-page horizontal overflow or page errors reported. Full matrix predates final two small layout fixes; only English load checks rerun after those.
- Known visual gaps: narrow skill-install URL and equal-width Tabs content clip; Japanese mobile chat history/agent-link exchange measured roughly 166px beyond card edge, unresolved. Review these before approval.
- Isolation qualifications: app-wide POST /stream/ticket reconnect remains and is excluded from the no-requests assertion. Locale selector persists the application's language using existing mechanism. Clipboard/link/file-picker demos retain real local platform interactions. Elevation deadline is one hour after mount, not fully deterministic. No demo sends messages, executes tools or requests real approvals according to coder tests.
- Not checked: every section/locale by visual inspection, real Android/GPUI desktop, dark scheme, hover/tooltip, every overlay in Chrome. Some overlays tested headlessly only.
- Scope additions: optional group/q URL filters; exported existing LANGUAGES; inventory check added to whole-suite runner; shellless navigation-motion classification.
- Initial code push lacked credential repository path; retry with per-command credential.useHttpPath=true succeeded. No force pushes, base/tag changes, or protected-path modifications.
Moved new/ -> review/, round 1. Next step: independent review, especially inventory omissions, narrow-screen clipping, and fixture side-effect/determinism qualifications.


## factory · review · 2026-11-16 14:19
head: 8f717938ce2150b14ef08d5ad672cd649d52d445
verdict: pass
notes:
- [P2] web/console-nsh/pages/ui-components/demos/chat.tsx:615: fold controls recreate keyedState on prop reads, so clicking “How the score works” does not expand the preview (probe text count unchanged at 2966). Allocate stable stores outside JSX; inspect the same pattern at line 623.
- [P2] web/console-nsh/pages/ui-components/demos/chat.tsx:389: composer file labels are built once; switching to Chinese leaves the files composer showing “Loading”, not “加载中”. Make labels and dependent file counts reactive.
- [P2] web/console-nsh/pages/ui-components/demos/controls.tsx:594: msg_loading is absent from the locale catalog; affected loading demos expose the raw key, including an accessibility label verified by probe. Use uig_state_loading or another existing key throughout the gallery.
- [P2] web/console-nsh/pages/ui-components/demos/settings.tsx:433: CodexAuthDialog and ProAuthDialog retain hard-wired production usage links (chatgpt.com/codex/settings/usage and router.mistermorph.com/console/usage), contrary to the documented example.com destinations. Inject a synthetic URL via DeviceAuthDialogContent or accurately document these exceptions. Verified by tracing handlers, not opening the links.
- [P2] web/console-nsh/pages/ui-components/demos/overlays.tsx:144: timeout-zero notices persist in the real notice stack when the section unmounts and the local id list is lost. Probe: warning notice remains after switching to Motion. Dismiss fixed gallery notice ids on unmount or reset all known ids.
- [P2] web/console-nsh/scripts/ui-components-inventory.test.mjs:31: column-zero regexes silently miss nested component declarations; 37 indented declarations include ReadoutCard, EventRow and VoiceOrSend. The inventory check still passes. Include nested declarations and explicitly list private parts rather than claiming exhaustive coverage.
- [P2] web/console-nsh/pages/ui-components/inventory.js:377: some omissions are incorrectly attributed to unavoidable live stores/APIs. TopicRenameDialog, TodoIndex, TodoCalendar, UnsupportedSection and ArtifactPreviewCard accept injectable props/state. Provide safe fixtures where possible and correct omission reasons. Coverage remains partial even though each requested category has mounted examples.

Validation (independent Claude Code review of origin/master...HEAD, 21 changed files):
- Required gofmt/vet/go test command passed: 163 packages, none failed.
- nsh check passed.
- Required Console scripts/test.sh passed: 126 files, zero failed, 347 seconds; inventory check passed. Five non-gallery files required the runner's built-in isolated retry and then passed: settings-menus, chat-scroll-anchor, stats-coder-quota, glass-page-heads, settings-page-sections. Baseline flakiness was not checked.
- First test attempts hit shared temporary-filesystem exhaustion; all checks were rerun successfully using home-cache scratch and absolute throwaway HOME. No installs or downloads reported.
- Authenticated route, shellless registration, absence of navigation entry and unchanged public preview checked. No commits or persistent repository changes by reviewer; manager confirmed clean worktree and unchanged head.
- No P0/P1 findings. Per factory policy, P2 notes do not block moving to ready; pass is not a claim that every acceptance detail is complete.
Residual risks:
- No real-browser review in this run. Build-reported Japanese mobile chat clipping (~166px), narrow skill-install URL and equal-width Tabs clipping remain unverified and unresolved.
- Dark scheme, hover/tooltips, real Android/desktop builds, clipboard and file picker were not checked. Owner should examine inventory completeness, live-link exceptions and narrow-screen behavior before shipping.
Moved review/ -> ready/. No linked issue or PR was present in the item.


## factory · 2026-11-16 15:25
Owner approved: "FT134 is fine move on. Cc Claude".
Shipped using Claude Code. Clean merge commit: 0200398d20a3326a5e61c3ac9156aa674fc0d9cd (parents c611561e and reviewed 8f717938). No integration fixes or unrelated changes.
Annotated tag: v0.3.114. Atomic master/tag push succeeded; remote master and peeled tag independently verified at the merge commit.
Checks on final clean HEAD: gofmt, go vet ./..., go test ./..., nsh check, required Console scripts/test.sh (126 files, zero failures; chat-attachments passed isolated retry), 280 Node tests plus 24 Cloudflare tests all passed. Absolute throwaway HOME and home-cache TMPDIR used. No additional installs reported.
No live-browser/visual/device checks or platform builds during shipping. Existing review P2 findings, inventory limitations and mobile clipping remain unchanged; approval is not a claim of exhaustive component coverage. Route: authenticated /ui-components, no normal navigation entry.
No linked issues or PRs to close. Branch retained (configured ship defaults do not include clean). Moved ready/ -> done/.
