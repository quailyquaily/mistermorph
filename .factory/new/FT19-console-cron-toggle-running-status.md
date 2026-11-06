# Show aggregate cron running status on the topic toolbar toggle

## factory · 2026-11-06 16:32
Owner request: “factory new feature: when there are cron task is running, give a running status to the cron toggle button at the topic column topbar as well. the design should fit our design as well. do the status design wisely.”

Requirements:
- Show aggregate running status on the existing cron / TODO runs toggle in the topic column topbar whenever any cron-triggered topic task is running, including scheduled TODO runs. Show it regardless of the selected topic or whether the cron filter is active.
- Use authoritative run status and trigger metadata across the current Console scope, not just visible/filtered topics. Do not count queued or terminal tasks, or manual runs merely because they share a cron topic.
- Keep the toggle always visible, enabled, and clickable. Running is informational, not a disabled/loading button state. Preserve its recognizable icon, filter action, selected styling, focus, and pressed semantics.
- Design direction: reuse the existing topic running indicator's visual language and Console color, spacing, and motion tokens. Prefer a small, restrained activity marker attached to the existing icon with no toolbar resizing or layout shift. Do not replace the cron icon with a spinner, introduce a prominent new pill, or use flashing effects. Running and filter-selected states must remain independently distinguishable.
- Do not rely on color alone. Provide localized tooltip and accessible label text such as “TODO runs — 2 running”. Honor reduced-motion preferences with a static equivalent; avoid repetitive live announcements.
- Reuse existing status events/refresh mechanisms, not a separate high-frequency polling loop. Initialize correctly on page load and reconcile after reconnect. Duplicate/replayed events must not inflate counts. Clear the indicator when the last running cron task completes, fails, or is cancelled; a transient refresh failure is not evidence of completion.
- Leave topic-level statuses, unread behavior, cron execution, and notification policy unchanged. This is passive running status, not a completion notification.

Acceptance checks:
- Cover zero, one, and multiple running cron tasks. Finishing one of several preserves the indicator; finishing the last clears it.
- Verify all four running/idle and selected/unselected combinations. Filtering remains usable during execution.
- Runs outside the visible list still contribute; manual-only runs do not. Cover mixed manual/cron topics and duplicate events.
- Cover initial load, reconnect, refresh errors, successful completion, failure, and cancellation without false or stuck status.
- Inspect the actual UI at narrow/wide sidebar widths and in supported themes: no clipped marker, layout shift, or hover/focus/selected-style conflict. Check keyboard access, accessible labels, localization, and reduced motion.
- Add regression tests for aggregation and button-state rendering using the existing test setup.

Scope: read-only Console status presentation and minimum status plumbing needed for accuracy. No implementation in this intake change.
