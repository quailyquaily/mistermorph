# Move the UI component gallery to /__ui-components and give it a way out to the login page

## factory · 2026-11-24 20:16
Owner request: “move /ui-components to /__ui-components. add a way to quit to login page. add to new/”

The UI component gallery (`web/console-nsh/pages/ui-components/`) is a testing page with no navigation entry, at `/ui-components` (`lib/router.ts:95`, `{ pattern: "/ui-components", page: "uiComponents", meta: { shellless: true } }`). It sits behind the session guard like any page, but it has no sidebar and no way to leave: its header holds only the title, appearance and language tabs (`pages/ui-components/UiComponentsPage.tsx:261`).

1. **Move the address** to `/__ui-components`, next to the other underscore testing pages (`/__boot-preview`, `/__components`). It stays behind the session guard and the setup check, as today (not `public`), and stays shellless with no navigation entry. The old `/ui-components` no longer opens the gallery: it is handled like any unknown address, with no redirect. Optional start parameters keep working at the new address (`/__ui-components?group=<id>&q=<text>`). The folder, component names, test ids (`ui-components-page`, `uig-*`) and the inventory file keep their names.
2. **A way to quit to the login page**: a control in the gallery's header that logs out and lands on `/login`. It does what Settings' log out does (`pages/settings/store.ts:3238`): `POST /auth/logout`, `authState.clear()`, `cacheClear()`, then `navigate("/login", { replace: true, force: true })`. Share that one function rather than copying it. Use the existing log out label (`action_logout`) and an existing button style. It must fit the header at phone widths (360/390pt) alongside the appearance and language tabs. While the logout runs, the control is disabled; a failed request still clears the session locally and lands on `/login`, as in Settings.

Update every reference to the old address: `docs/console/ui-components.md`, `docs/console/corners.md:92`, `web/console-nsh/PORTING.md:36`, the comments in `lib/router.ts`, `pages/ui-components/inventory.js` and `tests/ui-components.test.tsx`.

Acceptance criteria:
- `/__ui-components` opens the gallery with a session; without one it goes to `/login?redirect=%2F__ui-components` and opens the gallery after login; an agent not yet set up gets setup.
- `/ui-components` no longer shows the gallery.
- No navigation (sidebar, phone bar, More sheet) leads to the gallery, as today.
- Pressing the quit control in the gallery calls `/auth/logout`, clears the session and cache, and shows the login page; going back does not reopen the gallery without logging in again.
- The control fits the header at 360pt and 390pt and on desktop, in light and dark.
- `tests/ui-components.test.tsx` covers the new address, the old one, and the quit flow; the inventory test and the full Console test runner pass.
