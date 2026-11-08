# Fix UI lag after opening Inspect Context

## factory · 2026-11-08 12:26
Owner request:
> After enter the inspect context window view, the UI will become lagging. I don't know why.

Investigate and fix the responsiveness regression triggered by opening the Inspect Context view. The cause is unknown; reproduce and profile before choosing a fix. Device scope was not specified; check both mobile and desktop.

Acceptance criteria:
- Opening and interacting with Inspect Context does not cause sustained UI lag or block navigation, scrolling, or typing elsewhere in the console.
- Check representative small and large contexts, background updates, and repeated open/close cycles.
- Closing the view leaves no view-specific work running unnecessarily and restores normal responsiveness.
- Preserve existing context content and inspection functionality; do not hide data merely to mask the slowdown.
- Record the confirmed cause and before/after performance evidence, and add focused regression coverage where practical. Explicitly report any browser or device checks not performed.

Registered in new/ only; implementation and diagnosis have not started.

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## factory · 2026-11-08 19:36
Moved from backlog to new at the owner’s request: “FT26, 27 放到 new”.
