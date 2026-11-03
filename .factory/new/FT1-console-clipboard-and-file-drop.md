# Console Web: paste images and drag-and-drop files

## lyric · 2026-11-03 18:05

Support pasting images from the clipboard and dragging and dropping files into the Console Web conversation composer.

### Acceptance criteria
- Pasting clipboard image data attaches the image to the outgoing message; ordinary text paste continues to work.
- Dropping one or more files into the composer attaches them without navigating the browser away from the conversation.
- Show pending attachments before sending and allow users to remove them.
- Sending delivers the attachments to the agent, not just their names or browser-local URLs.
- Show actionable errors for failed uploads or unsupported files, preserving the draft and allowing retry.
- Cover clipboard image paste, file drop, attachment removal, and the send/error paths with appropriate regression tests.
