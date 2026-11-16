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
