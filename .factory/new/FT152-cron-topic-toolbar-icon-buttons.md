# Cron job topic bottom toolbar: icon buttons and primary run control

## factory · 2026-11-18 23:57
Owner request from Console:

> UI fix: at the cron jobs topic page bottom toolbar, do not use label buttons, use icon buttons, just like bottom nav. The stop icon should be a different color. The stop/start button should be primary button, with solid color bg color. The buttons height should increase a little to make margin are same.

Acceptance criteria:
- Update the existing bottom toolbar on cron job topic pages in the current Console (`web/console-nsh`), not the retired Vue console.
- Replace visible text-label buttons with icon-only buttons, matching the bottom navigation's icon sizing, alignment, and visual treatment. Preserve accessible names and provide appropriate tooltips for each action.
- Render the Start/Stop action as a primary button with a solid background, not a transparent or outline-only control. Give the Stop icon a distinct stop/danger color, with sufficient contrast against its background in both themes; distinguish it from Start and the secondary action.
- Slightly increase button height and adjust padding so the toolbar's top/bottom inset is equal and its side spacing looks balanced, consistent with the bottom navigation. Keep all controls aligned and usable on narrow/mobile screens, including bottom safe areas.
- Preserve existing Start/Stop and View Job behavior, actual running-state synchronization, loading/disabled states, and duplicate-action protection. This is a visual UI fix, not a change to job or scheduling semantics.
- Add regression coverage for icon-only accessible controls, primary Start/Stop styling, distinct Stop color, and idle/running/pending states. Verify balanced spacing and contrast on desktop and mobile in light and dark themes.
