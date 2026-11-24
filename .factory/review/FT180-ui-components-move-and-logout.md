---
branch: factory/FT180-ui-components-move-and-logout
round: 1
---
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

## factory · plan · 2026-11-24 21:07

## Behaviour
- Register only /__ui-components, retaining shellless session/setup guards and group/q parameters. Treat /ui-components as unknown, without an alias.
- Add an existing-style, action_logout-labelled header button, disabled while pending. POST /auth/logout; always clear auth/cache and replace with /login, even on failure. Settings calls the same shared function.
- Keep gallery identifiers, inventory and navigation unchanged. Header controls wrap within 360/390px and desktop in light/dark.
## Scope
Route, gallery header, minimal shared logout helper and Settings integration, regression tests and old-address references in docs/source. No redesign or navigation additions.
## Decisions
Extract an independent logout operation, not the Settings store, avoiding Settings loading from the gallery. Keep caller-local busy state with finally reset. No compatibility alias. Use repository-pinned nsh 0.6.0 rather than stale factory comment.
## Checking
Cover session/login redirect, setup guard, unknown old address, query filters, success/failure logout cleanup and routing, pending disabled control and navigation guard. Inventory and no-navigation tests remain valid.
Run nsh check, scripts/test.sh (failed files retried alone), and test -z "$(gofmt -l .)" && go vet ./... && go test ./... . Scripted tests use throwaway HOME, XDG and configured tool caches.
Visually inspect header at 360/390px and desktop in both appearances if possible; explicitly report if not inspected.

## factory · 2026-11-24 21:07

Built b807c31f: gallery moved to /__ui-components; old address now has ordinary unknown-route handling. Added a wrapping logout button, shared session/cache cleanup with Settings, pending-state protection, docs and regression tests. Kept gallery identifiers, query filters, session/setup guards and navigation unchanged.

Tests: nsh check passed; gallery tests 20/20; full Console runner 164 files, 0 failed; inventory checks passed. Required gofmt/vet/go test command passed in coder and manager verification (168 packages). No installs.

Visual checks reported by coder: headless Chrome at 360, 390 and 1280 in light/dark; button fits with no overlaps and logout/back behaviour checked. Not checked on real iOS/Android devices or desktop GPUI; Android cache cleanup tested headlessly.

Process notes: coder wrote tooling memory notes outside the run directory (factory-build-tooling.md and MEMORY.md in its Claude project memory); no secrets included. Existing /tmp/claude-995 remains tracked as an outside-dir path, not deleted. Push initially needed per-command credential.useHttpPath=true; retry succeeded.

Moved new/ → review/ for independent review.
