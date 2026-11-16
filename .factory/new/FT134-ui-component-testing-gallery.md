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
