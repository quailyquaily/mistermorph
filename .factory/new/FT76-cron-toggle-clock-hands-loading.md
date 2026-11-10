# Cron toggle loading should animate clock hands instead of using button loading styles

## factory · 2026-11-11 00:34

Recorded from the owner’s explicit request to add this correction to `new/`.

Follow-up to shipped FT61. The owner rejects directly reusing button loading styling for the cron toggle and suggests animating the clock icon’s two hands like someone adjusting the time.

### Acceptance criteria

- Remove generic button-loading styling from the cron toggle pending state. Preserve the toggle’s own dimensions and visual identity.
- Animate the minute and hour hands within the clock icon while the toggle request is pending; make them move distinctly like a clock being adjusted, rather than spinning the whole icon or using a generic button spinner.
- End the animation on success or failure and show the correct resulting toggle state. Prevent duplicate pending requests and retain failure feedback/retry behavior.
- Respect reduced-motion preferences with a clear non-animated pending indication. Verify the appearance directly, including pending, success, and failure states.

Intake only; implementation has not started.
