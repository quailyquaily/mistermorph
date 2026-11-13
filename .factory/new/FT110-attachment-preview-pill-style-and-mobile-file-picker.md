# Attachment previews, rounded file pills, and mobile file picking

## factory · 2026-11-14 06:44
Owner request from Console:

> Select a file in composer, the file pill can't be previewed even if it's just a picture. After sending, it can be previewed in the bubble.
> And the pill needs more border radius, just like the single line composer.
> When the pill is in the bubble, remove the file type at its right, because the file extension already tells us.
> And the Upload files should support to pick files instead of photos on the phone. You can implement those telegram-like attachment pick views as the screenshot shows.
> Add to new/

### Required behavior
- Before sending, clicking/tapping a selected image attachment in the composer opens a preview, consistent with the preview available after sending. Keep attachment removal independently usable; previewing must not submit the message or discard the draft.
- Give file pills a larger border radius, visually matching the single-line composer's rounded shape. Preserve rounded corners in both draft and sent states, including narrow screens; do not regress FT107.
- In sent message bubbles, remove the redundant file-type label at the pill's right. Keep the filename and its extension, and retain useful actions/metadata unrelated to that redundant label.
- On phones, Upload files must allow choosing arbitrary supported files from the system file/document picker, not only choosing photos. Provide clear Gallery and File choices using the attached Telegram screenshots as the visual/interaction reference. Gallery opens photo selection; File opens the system file/document picker. Do not pretend a web app can enumerate private storage or Telegram's app directory: use platform-supported pickers and sensible browser fallbacks.
- Preserve existing upload limits, validation, multiple-attachment behavior, sent-image previews, and desktop file selection.

### Reference screenshots
- [Telegram Gallery attachment view](../references/FT110/telegram-gallery-picker.jpg)
- [Telegram File attachment view](../references/FT110/telegram-file-picker.jpg)

Use the Gallery/File separation and rounded attachment-sheet presentation as guidance; the screenshots do not request unrelated Telegram tabs or functionality.

### Acceptance checks
- Select an image without sending; open and close its preview, then remove it or send it successfully. Cover multiple attachments, unsupported preview types, and resource cleanup when a draft attachment is removed or replaced.
- Verify pill curvature, long filenames, removal controls, and absence of the redundant right-side type label in sent bubbles on desktop and mobile widths.
- Verify File selection accepts a non-image document on mobile, while Gallery still selects images. Canceling either picker keeps the draft intact; selecting the same file again works after removal.
- Check keyboard/touch accessibility, sheet dismissal, viewport containment, and regressions in existing attachment upload/preview tests. Clearly state which real mobile/browser checks could not be run.

Status: requested only; no implementation or cause diagnosis yet.
