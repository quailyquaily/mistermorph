# Keep Setup available from Settings after initialization

## factory · 2026-11-27 07:37
Owner intake: add an independent new/ requirement, not an implementation. Keep a Setup entry in a suitable Settings location so an initialized user can run through Setup again. Preserve configuration, protect sensitive values, prevent accidental resets, and follow the existing UI.

### Verified baseline and duplicate check
Inspected master at 289c27b3 and every numbered Markdown item on factory_board through FT191. No existing item requests this behavior. FT180 concerns gallery routing/logout, FT170 concerns login endpoint editing, and FT36 concerns database storage/repair; none provides Settings-to-Setup re-entry.

- The active Console is web/console-nsh. pages/settings/sections/GeneralSection.tsx contains device/session controls; AgentSection.tsx and PersonaSection.tsx contain endpoint-specific settings. Reuse existing SettingsCard, SettingRow, Button, localization and navigation patterns, not a new panel design.
- lib/router.ts defines endpoint-scoped /setup and /setup/{llm,persona,soul,done}, authenticates access, checks integrity and endpoint selection, and gates uninitialized agents. lib/core/setup.js resolves readiness and has endpoint-keyed caches.
- pages/setup/setup-state.ts syncRoute sends a ready endpoint's bare /setup to /setup/done. Merely linking that URL does not reopen the editable flow. Current step forms load existing LLM settings, persona/avatar and soul; saves are per step.
- LLM settings use /settings/agent and existing env-managed/secret-field handling. Persona uses the persona-profile read/save abstraction. Do not replace these with fresh templates.

### Required behavior and scope
1. Add a clearly labeled Setup row/action to Settings, visible after setup completion. Prefer the endpoint-specific Agent settings area, with a short explanation that it reopens setup without resetting data. Use the explicitly selected endpoint, not a silent fallback to console-local or a different Agent. If unavailable/unsupported, disable or explain using the existing error style.
2. An explicit Settings action opens the first editable Setup stage even for a ready endpoint. Today that stage is LLM; when FT193 is present, it is the user-name page. Preserve the chosen endpoint across navigation. Use a small explicit re-entry state only if needed; do not change ordinary first-run readiness or repair semantics to fake an uninitialized installation.
3. Load saved values rather than defaults. Entering, going Back, cancelling, reloading or leaving Setup must not clear settings, identity, soul, avatar, credentials, profiles, channels, workspaces, history or setup-completion state. No reset API or destructive initialization is called by the entry action. Keep the existing missing-file readiness behavior, but never overwrite existing files.
4. Save only on an explicit existing step save/continue action. An unchanged secret input means keep the stored secret, not delete it or submit a mask as a replacement. Preserve env-managed/read-only values and unrelated fields. Do not expose plaintext credentials in new API responses, route/query state, logs, notifications or browser persistent storage. Continue through already-configured steps without demanding replacement keys or new OAuth sign-in solely because setup was reopened.
5. Preserve the current per-step save contract: an explicitly saved step remains saved if a later step is cancelled; unsaved edits are not written by navigation. Communicate that contract with existing UI conventions if necessary, not a new multi-step transaction system. Existing explicit edits to persona/soul remain possible, without silently installing template content.
6. Provide an obvious way back to the originating Settings context (and correct endpoint), including mobile Back. Completion returns to the existing usable Console flow; a reload/deep link cannot cause a setup redirect loop. Failed loads must not enable saving defaults over unknown stored values; failed saves show an error and allow retry without advancing.

Out of scope: implementing FT193's user identity page, factory reset, account/authentication redesign, new setup wizard architecture, new credential export, or changing unrelated Settings pages. Coordinate with FT193 if it ships first; neither item requires a combined build.

### Verifiable acceptance criteria
- With a fully configured endpoint, Settings exposes the Setup action; activating it opens an editable first stage, not just Done. First-run setup still works without using Settings.
- With two configured endpoints carrying different values, re-entry and all saves target only the selected endpoint. Unavailable endpoint and unauthenticated navigation preserve existing guards; integrity repair remains available and is not bypassed.
- Seed non-default model/profile values, saved credentials, env-managed values, persona/avatar and custom soul. Enter and exit without saving, reload midway, and continue unchanged: values remain intact, secrets are not erased/replaced or newly leaked, and no reset request occurs. Existing history/workspaces/channels remain unchanged.
- An intentional single-field edit changes only its intended setting; saved earlier steps survive later cancellation. Load/save errors do not advance or overwrite values with defaults.
- Exercise first-run, ready re-entry, Back/exit, Done, reload and repair routes in router/setup tests; add a Settings action test and regression coverage for unchanged/omitted secrets and endpoint targeting in the appropriate existing backend tests.
- Check desktop and 360/390pt mobile layouts, keyboard focus/Back behavior, light/dark appearance, and en/zh/ja labels using existing components. During implementation run the configured Go checks, nsh check and web/console-nsh/scripts/test.sh. This intake runs none of those build/review/ship actions.
