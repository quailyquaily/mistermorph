# Hide Settings → General → App outside a web browser

## factory · 2026-11-24 22:22
Owner request: “if not in web browser, no need to show general -> app”

Settings → General ends with the App card (`components/settings/SettingsAppPanel.tsx`, `SettingsAppPanel`, rendered at `pages/settings/sections/GeneralSection.tsx:76`, test id `settings-app`). It offers to install the Console as an app for the selected agent, which only means something in a browser: in the desktop app it just says "Already running in the desktop app." (`settings_app_hint_desktop`), and in the Android app it has nothing to install.

1. Show the App card only when the Console runs in a web browser: not in the desktop app (`lib/platform.ts` `isDesktop()`, `lib/core/desktop-runtime.js` `isDesktopRuntime()`) and not in the phone app (`lib/platform.ts` `isMobile()`, `config.runtime === "mobile"`), nor any other shell (`shellInfo()` not null). Use one check for "in a browser" rather than listing shells at the call site.
2. Outside a browser, nothing of it is drawn: no empty card, no gap left behind at the end of General.
3. If Settings search indexes the App card's title or text, it must not find it outside a browser either.
4. Strings that only the removed desktop case used (`settings_app_hint_desktop` and any other) go, in every language, if nothing else uses them.

Acceptance criteria:
- In a browser (secure origin or not), General shows the App card as today.
- In the desktop app and the Android app, General shows no App card and search does not find it.
- `tests/settings-page-sections.test.tsx` (which waits for `id:settings-app`) still passes, and new tests cover the desktop and mobile runtimes hiding it; the full Console test runner passes.
