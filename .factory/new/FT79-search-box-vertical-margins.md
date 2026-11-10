# Adjust search box vertical spacing

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: search box 的 margin top 再增加一些，margin bottom 再减少一些。

Acceptance:
- Increase the search box top margin and reduce its bottom margin relative to the current layout.
- Choose a modest adjustment consistent with existing spacing tokens; no exact pixel amount was requested.
- Verify the search box remains aligned and usable at narrow and wide window sizes without overlap or clipping.
- Limit changes to search box spacing; preserve search behavior.
