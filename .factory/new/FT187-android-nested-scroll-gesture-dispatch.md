# Fix Android nested scroll gesture dispatch for Markdown tables and Jobs deps

## factory · 2026-11-25 08:45
Owner reports that wide Markdown tables scroll horizontally in the mobile browser but still fail in the mobile App after FT176. Owner approves adding a follow-up to new/ for the shared native scrolling fix discussed in the investigation.

Scope and evidence:
- Investigate and fix Android/native nsh nested scroll gesture dispatch rather than applying browser-only CSS changes. Prior Claude source inspection of nsh 0.6.0 suggests that an outer ScrollBox cancels child touch events when the gesture is on the other axis. This is a hypothesis supported by source inspection, not a device-confirmed root cause; recheck the current dependency and actual call path before changing it.
- Primary case: a horizontally overflowing Markdown table inside the vertically scrollable chat list. Also cover wide code blocks and the Jobs dependency graph with crossed horizontal/vertical scroll containers.
- Prefer a corrected upstream/runtime version or a reproducible, narrowly scoped dependency patch integrated into the App build. Do not rely on edits to a developer's installed runtime, silently modify another repository, or replace the diagram with a custom canvas gesture system.

Acceptance:
- In the Android App, wide tables and code blocks can be dragged horizontally in both short and long, vertically scrollable conversations; the page/message width remains constrained, and vertical chat scrolling still works.
- Jobs deps supports horizontal and vertical finger scrolling when content overflows both axes. Preserve node clicks and existing desktop/browser scroll behaviour.
- Check gesture ownership at boundaries and direction changes; preserve taps, text selection, and child interaction without stuck/cancelled gestures or unintended parent scrolling.
- Add regression coverage for the native gesture-dispatch path where feasible. Browser tests or simulated nsh tests alone do not establish Android correctness. Record the exact runtime version and what was actually tested on an Android device/emulator; explicitly state missing native verification rather than claiming the bug is reproduced or fixed on-device.
## factory · 2026-11-25 08:46
Owner follow-up: "是的 代码块也有一样的问题，加到 ft187" (wide code blocks also exhibit the same scrolling failure in the mobile App).

This confirms the code-block symptom as an owner-observed failure, not merely a prediction from source inspection. Keep wide Markdown code blocks as an explicit required regression case alongside tables, including horizontal finger scrolling inside a vertically scrollable conversation. The shared native root cause remains unverified on-device until tested.
