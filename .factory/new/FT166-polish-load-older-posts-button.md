# Polish the Load older posts button

## factory · 2026-11-20 10:20
Owner requests visual polish for the button used to load older posts/history, including the mobile app experience.

### Required behavior
- Identify the existing older-posts/history loading control in the Console and polish its appearance to match the surrounding UI and current shared button styles. Reuse existing components and tokens rather than introducing a new button system.
- Improve corner treatment, spacing, alignment, typography, and interaction states. Keep the control visually restrained but clearly actionable, with a comfortable mobile touch target.
- Ensure the button looks correct in mobile apps, mobile web, and desktop layouts, including supported themes. Avoid clipping or overlap with surrounding content and safe areas.
- Preserve pagination, chronological order, scroll anchoring, and loaded content. Show a clear loading/disabled state and prevent duplicate requests; retain existing error/retry and end-of-history behavior.

### Acceptance checks
- Check default, hover/focus/pressed where applicable, loading, failure/retry, and no-more-history states. Preserve keyboard accessibility and an accessible label.
- Add or update focused regression coverage for any changed behavior; run existing history-loading/scroll-anchor tests when touching those paths.
- Record which visual/device checks were actually performed; do not claim native-device verification from source inspection alone.
