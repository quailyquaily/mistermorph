# Mobile progress box dark background and cron topic scroll stability

## factory · 2026-11-08 12:06
Registered from the owner's request; not implemented.

Owner report:
> Factory new bugs on mobile view:
> 1. The background of the progress box should be dark
> 2. When stay at the topic view of cron topic, and open the progress, wait for awhile, the scoll position of topic view will change unexpectedly.

Requested behavior:
- On mobile, give the progress box a dark background with readable text, icons, and controls.
- Fix unexpected scrolling in a cron topic when its progress is open and the user waits. Background progress updates must not unexpectedly reposition the topic view.

Reproduction for the scroll bug:
1. Open a cron topic in the mobile Console.
2. Open its progress display.
3. Leave the topic view open and wait for background updates without scrolling.
4. Observe the topic view's scroll position changing unexpectedly.

Acceptance checks:
- The mobile progress box has a dark surface and readable content.
- With progress open, idle/background updates preserve the user's visible topic position, including when reading older messages rather than the bottom.
- Opening and closing progress does not introduce unintended topic scroll jumps.
- Preserve intentional scrolling and existing follow-at-bottom behavior where appropriate; do not disable scrolling globally.
- Add regression coverage for update-driven scroll movement and verify the mobile layout visually. Check desktop for regressions.

The cause is not yet verified; investigate update/layout/scroll interactions rather than assuming a particular cause.
