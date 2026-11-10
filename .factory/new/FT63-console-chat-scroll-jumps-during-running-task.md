# Diagnose and fix chat scroll jumps while a task is running

## factory · 2026-11-10 09:43
Owner report:
> On the chatview, when the task is running, if I scroll at the view and stop at some position, the scrolltop will suddenly jump to another position. need to inspect the root reason and fix it.

Investigate and document the actual cause before implementing a fix; do not assume this is only an auto-scroll issue. Reproduce while streaming task output, manually scroll away from the bottom, then stop scrolling and observe subsequent updates. Inspect scroll writes, follow-bottom state, rerenders/remounts, browser scroll anchoring, and asynchronous content height changes as relevant.

Expected behavior and acceptance:
- Once the user scrolls away from the bottom, incoming task updates must preserve the reading position rather than unexpectedly moving the viewport.
- Preserve the visible content anchor when content above it changes height; an unchanged numeric scrollTop alone is not sufficient.
- Keep normal follow-bottom behavior when the user remains at the bottom; allow intentional return to the latest output to resume following.
- Verify streaming updates, tool/status updates, task completion, and topic switching on desktop and mobile. Preserve intentional initial positioning and navigation behavior.
- Add regression coverage for the confirmed root cause and record reproduction, diagnosis, fix, and checks performed. Explicitly note any browser/device checks not performed.

Registered for investigation and implementation; no root cause confirmed at intake.
