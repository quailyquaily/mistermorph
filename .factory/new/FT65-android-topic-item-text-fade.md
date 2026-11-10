# Android topic list: fade overflowing text at the trailing edge

## factory · 2026-11-10 10:14
Requested by the owner:
> android app 的 topic list item，如果文字比较长的话，应该像桌面端一样尾部区域渐隐

Match the desktop topic-list treatment in the Android app: when a topic item's text exceeds the available width, fade the trailing text region rather than cutting it off abruptly. Inspect and reuse the desktop behavior where appropriate.

Acceptance criteria:
- Overflowing topic text fades at its trailing edge in the Android app.
- Text that fits remains fully visible without an unnecessary fade.
- Preserve item layout, status indicators, hit targets, and desktop behavior.
- Check narrow Android layouts and long Chinese and Latin text; add suitable regression coverage and report whether Android rendering was visually verified.
