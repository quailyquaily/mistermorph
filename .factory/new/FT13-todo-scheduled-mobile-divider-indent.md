# Fix Scheduled divider left indentation in mobile Todo view

## factory · 2026-11-05 10:55
The owner requested a new item: in the mobile Todo view, the Scheduled section divider has incorrect left indentation and should align the same way as the divider in Chat.

Acceptance criteria:
- Match the Scheduled divider's left inset to the corresponding Chat divider at mobile viewport widths.
- Check the actual Chat layout/styles as the reference rather than introducing an unrelated spacing value.
- Keep the Scheduled label and divider aligned consistently; preserve the existing desktop layout.
- Verify both Todo and Chat at mobile widths, and check desktop for regressions.

This item records the request only; implementation has not started.
