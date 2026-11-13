# Web Console favicon shows the selected agent's avatar

## factory · 2026-11-13 15:22
Owner request: "New feature request for web ui. the favicon should change to current avatar of agent."

Today the web Console's favicon is the static app icon that the nsh build writes into `index.html` (`<link rel="icon" sizes="32x32" href="icons/32.<hash>.png">`). The selected agent's avatar is already loaded for the frame: `components/frame/personaSummary.ts` → `lib/stores/personaStore.js` (`avatarURL`, a `blob:` URL from `fetchPersonaAvatarBlob`, reloaded on `PERSONA_AVATAR_UPDATED_EVENT` and when `endpointState.selectedRef` changes), with the endpoint's `avatar_url` as the fallback (see the `selectedAvatar` prop of `components/frame/AgentSwitcher.tsx`). The page title already goes through a host call, `morph.title` (`lib/platform.ts` `setDocumentTitle` → `host.js`), so the favicon can take the same route.

Expected behavior:
- In the web Console, the browser tab's favicon is the currently selected agent's avatar: the persona avatar, else the endpoint's avatar, the same image the agent switcher shows.
- It updates without a reload when the user switches agents and when the avatar is changed in persona settings or setup.
- With no avatar (or while it loads, or if it fails to load), the favicon is the default app icon, never a broken or blank one. Switching to an agent without an avatar restores the default.
- Render it as a small square icon that reads well at 16/32 px (e.g. drawn to a canvas, cropped to fill, round like the switcher's avatar); keep the existing `apple-touch-icon` as is.
- Add a host call (e.g. `morph.favicon`) next to `morph.title` in `host.js`; make it a no-op in `lib/mobileHost.ts` and in the test harness (`tests/harness.ts`), and leave the desktop and Android apps unchanged.
- Check whether a `blob:` URL made by the app can be loaded by the host page. If not, pass the image another way (bytes or a data URL), and revoke any object URLs the host creates when the icon changes.

Add tests for the favicon updates (agent switch, avatar change, no avatar falls back to the default). Run `nsh check` and `nsh test --web-host tests/noHost.js` in web/console-nsh.
