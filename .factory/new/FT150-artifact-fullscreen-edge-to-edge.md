# Remove outer spacing from fullscreen artifact previews

## factory · 2026-11-18 18:13
Owner requests a UI fix: fullscreen artifacts should not have margins around the WebView/preview. The spacing may come from the surrounding dialog's padding; inspect the actual source rather than assuming it belongs to the WebView.

Requirements:
- In fullscreen mode, make the artifact WebView/preview fill the available content area edge to edge, removing unintended outer margins, padding, or gaps introduced by the preview container or dialog.
- Do not strip spacing authored inside the artifact itself, and preserve the normal non-fullscreen preview layout.
- Keep fullscreen close/exit controls visible and usable; avoid clipping, unwanted outer scrolling, and regressions on desktop or mobile, including necessary safe-area handling.
- Verify entering and exiting fullscreen, viewport resizing, and desktop/mobile layouts; add focused regression coverage for the fullscreen container sizing and spacing.
