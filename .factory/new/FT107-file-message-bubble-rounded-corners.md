# Preserve rounded corners on message bubbles containing files

## factory · 2026-11-13 08:43
Owner report: "New UI issue: the bubble with a file, the border radius will be removed or covered for some reasons."

The supplied screenshot shows a message with text and a PNG attachment: parts of the bubble outline appear square or covered while other corners remain rounded. This is a visual defect; the exact CSS/painting cause has not been confirmed.

Expected behavior:
- Message bubbles containing attachments retain the intended rounded outer corners and a continuous, consistent border.
- Attachment backgrounds, wrappers, and interactive states must not paint over the bubble corners or extend beyond the rounded outline.
- Preserve text layout, attachment filename/type display, file opening/downloading, and the copy action.
- Verify text plus attachment, attachment-only, and multiple attachments on desktop and mobile, including long filenames and available themes.
- Add a regression check appropriate to the actual rendering cause and visually verify the rounded outline; do not assume the fix is simply adding overflow clipping if that would clip controls or focus indicators.

Scope: file-attachment bubble shape only. Command wrapping and activity prompt layout are tracked separately in FT106.
