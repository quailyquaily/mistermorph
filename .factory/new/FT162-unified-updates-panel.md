# Simplify Settings Updates into one unified Shell and server panel

## factory · 2026-11-20 08:55
The owner requested this task in new/:

> settings -> updates, no need pro channel, so no need to ask user to choose channel.
> Shell and server version, put them in one space, so we only need one refresh button and one place to show the new updates change log. So please rearrange the updates panel for better ux.

### Required behavior
- Rearrange Settings → Updates into one coherent area containing both Shell and server version information. Clearly label each component and distinguish installed versions from available versions.
- Remove the Pro channel option and the channel-selection control/prompt from this panel. Checking for updates must not require the user to choose a channel. Use the supported non-Pro/default release source automatically; do not add another channel-selection step elsewhere.
- Provide one shared refresh/check-for-updates button that checks all applicable components. Present loading, up-to-date, update-available, and failure states clearly; a failure checking one component must not hide a successful result for the other.
- Provide one shared changelog/release-notes area for available updates rather than separate duplicated areas. Identify which component and version each entry describes, and avoid duplicating identical notes when components share a release.
- Preserve any necessary component-specific install/update actions and existing safety checks. A single refresh button does not mean silently combining update installation or restarting either component.
- Handle environments where only one component is available or updatable without displaying broken or misleading controls. Preserve usable responsive layouts on mobile and desktop, and existing localization/accessibility conventions.

### Scope and verification
- Inspect the current Settings Updates implementation and existing update-target tests before choosing the layout. Keep this focused on simplifying the update UX; do not remove unrelated backend release-channel support or change release infrastructure unless required by the panel behavior.
- Add/update regression coverage for no channel selection or Pro option, a single shared refresh control, checking supported components, partial failures, and the unified release-notes display.
- Run configured repository checks and required Console checks/tests. Visually check mobile and desktop layouts where feasible; explicitly report any checks not performed.
