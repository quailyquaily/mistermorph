# Fix Android swipe-back navigation and topbar layout

## factory · 2026-11-08 18:02
Requested by the owner in Console: “android 版本有个问题，无法左滑返回，然后 topbar 在 Android 上的尺寸和位置也不正确。加到 factory new 吧。”

Reported problems:
- On Android, the owner's expected swipe-back gesture (described as 左滑返回) does not navigate back.
- The topbar's size and position are incorrect on Android.

Expected outcome:
- Investigate the Android navigation gesture handling and restore expected back navigation. Confirm the gesture direction and edge behavior against existing navigation and Android conventions rather than assuming a new opposite-direction gesture is required.
- Correct topbar height, positioning, and system-bar/safe-area spacing on Android; prevent overlap, clipping, or doubled insets.
- Preserve existing iOS and desktop navigation and layout behavior.

Checking:
- Add regression coverage for back navigation and Android topbar inset/layout handling where practical.
- Check Android portrait and landscape layouts, navigation into and back out of a detail view, and interaction with scrolling and the keyboard.
- Record the Android environment tested. If physical-device gesture or visual checks cannot be performed, explicitly record those limitations rather than claiming verification.
