---
branch: factory/FT108-web-favicon-agent-avatar
round: 1
---
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

## factory · plan · 2026-11-13 16:16

### Behaviour
- On web startup keep the generated application favicon until a valid selected-agent avatar is available. Prefer the persona avatar, then the selected endpoint avatar, matching the switcher.
- React to endpoint switches and persona avatar updates without reload. Reset to the captured original favicon while loading or on absence/error. Ignore obsolete asynchronous loads so an old agent cannot replace the current icon.
- Draw a square 32px favicon with a centered fill crop and circular mask suitable for 16/32px tabs. Preserve apple-touch-icon and restore the exact original icon attributes on fallback.
- Transfer image data safely across the nsh app/host boundary: inspect runtime origins and blob ownership; if app blob URLs cannot be read by the host, transfer bytes/data URL using existing APIs. Release host-created object URLs on replacement.
- Desktop and Android remain unchanged: favicon calls are web-only or safely ignored, including mobile host and test harness.
### Scope
- Add a narrowly scoped morph.favicon host contract beside morph.title, web favicon renderer, platform bridge, and reactive selected-avatar synchronization at a single shared app/frame location.
- Add regression tests for startup/default, agent switching, avatar refresh, missing/failed avatar, stale async results, and host handling. Do not change app icons, touch icons, native apps, unrelated UI or dependencies unless necessary.
### Decisions
- Use a 32px circular center crop with transparent corners; no new persistent setting. Preserve build-generated default href rather than hard-coding assets.
- Inspect selected endpoint and persona-store lifecycle to avoid showing a previous endpoint's image and duplicated sidebar/mobile effects. Prefer the existing avatar loading pipeline; no duplicate network requests when avoidable.
- Use existing nsh version pinned by the repository (AGENTS.md says 0.5.0); configuration's 0.4.0 note is stale.
### Checking
- Add focused reactive and browser-host regression tests, including image failure and request races. Check whether cross-context blob loading works using runtime evidence, documenting the transfer decision.
- Run nsh check and nsh test --web-host tests/noHost.js in web/console-nsh, plus the full configured Go gate: test -z "$(gofmt -l .)" && go vet ./... && go test ./.... All scripted tests use a throwaway absolute HOME.
- Build web artifacts if necessary to validate host packaging. Report explicitly whether real browser rendering was inspected; native runtime/device testing is out of scope.

## factory · 2026-11-13 16:16

Built at `8890428f` on `factory/FT108-web-favicon-agent-avatar` from `588ad961`.

Added web-only morph.favicon host support and one reactive frame component: persona avatar first, endpoint avatar second, default app icon while loading, missing or failed. Center-cropped round 32px PNG, exact default icon restoration, stale-load protection, and untouched apple-touch-icon. Shared persona event listeners prevent duplicate avatar reloads. Mobile host and harness ignore the call; desktop and Android code unchanged.

Decisions: real Chrome verified the runtime iframe is same-origin and the host can load its blob URLs and read their canvas. Pass those URLs directly; output favicon is a data URL, so no host object URLs need revocation. Other-origin images without CORS fall back to the loaded image without cropping. No persistent setting.

Installs: none; no manifest or lockfile changes. Used existing repository-pinned nsh 0.5.0 and existing browser tooling.

Checks: configured gofmt/vet/go test gate passes, independently rerun by manager. nsh check passes, independently rerun by manager. Full nsh suite: 864 passed, 0 failed; after the final platform tidy-up, focused favicon/shell/login tests and type check passed. Added six reactive tests and seven browser-host tests. Real built-console headless Chrome probe: all 20 checks pass, including actual settings upload/crop, reload, endpoint switching, image pixels, and deleting the avatar. No forbidden paths changed; one item-only commit.

Not checked: visible browser tab strip (headless Chrome checks DOM and PNG pixels instead), Firefox, Safari, native desktop and Android devices. Second endpoint API was simulated in browser checks. Headless nsh cannot enable the image crop Save action, so replacement was exercised in Chrome instead.

Push: first credential-helper attempt lacked repository-path information; retry with per-command credential.useHttpPath=true succeeded. Branch pushed; no base or tags pushed.

## factory · review · 2026-11-13 16:47
head: 8890428f7043a815763b7773f9c6789267949b5f
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (merge-base 588ad961), all nine changed files, against the request and plan. No qualifying findings. Branch merges cleanly with current base; worktree unchanged.
- Validation: configured gofmt/vet/go test gate passes (exit 0); nsh 0.5.0 check passes (exit 0); nsh test --web-host tests/noHost.js passes, 864/864 tests, including all 13 new favicon tests. All scripted tests used throwaway absolute HOME directories.
- Installs: no unpinned tools or dependency changes; nsh populated its isolated cache with its TypeScript tooling.
- Limits: this review did not independently inspect a real browser tab, actual CORS/canvas rendering, Firefox/Safari or native devices. Cross-origin non-CORS images intentionally retain their original shape. Build-stage Chrome evidence is recorded above, not rerun in this review.

## factory · 2026-11-13 19:24
Shipped to master. Merge commit: d59aaa325d79cd65cb2ee59a010b6c70e1c1bcde. Release tag: v0.3.106.

Merged without conflicts or code fixes. Per-merge nsh check and full Console suite passed (897 tests, zero failures); changed tests passed. Final combined suite: 897/897; final configured gofmt/vet/go test gate passed. No unpinned installs or forbidden-path changes.

Claude Code prepared FT104–FT107 but was blocked by repeated Cloudflare HTTP 403 responses during testing; manager completed the remaining merge and shell checks directly. No fresh browser/native Android/native desktop visual verification in this ship run; remote CI completion unverified.

No linked GitHub issues or PRs identified; none closed. Branch retained (clean not configured). Moved ready/ → done/.
