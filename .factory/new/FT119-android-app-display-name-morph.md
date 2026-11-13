# Rename the Android app display name to Morph

## factory · 2026-11-14 08:24
Owner request: "Rename the Android app display name to \"Morph\"\nPut to new/"

Requirements:
- Set the Android app's user-visible display name to exactly `Morph`.
- Update the relevant Android label resources and any locale or build-variant overrides so the installed app consistently displays `Morph`.
- Keep the application ID, package name, signing configuration, and existing app behavior unchanged.

Acceptance checks:
- The installed Android app appears as `Morph` in the launcher and Android app settings.
- No existing locale or supported build variant restores the old display name.
- Android resource/build checks pass; explicitly note if device verification cannot be performed.

Scope: Android app display name only; no icon, web branding, or application identifier changes.
