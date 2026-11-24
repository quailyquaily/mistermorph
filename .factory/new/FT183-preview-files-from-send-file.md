# Preview a file the agent sent with send_file, when it can be previewed

## factory · 2026-11-24 22:55
Owner request: “if the file is previewable, also allow to preview in send_file tool”

A file the agent sends in the Console chat with `send_file` (`cmd/mistermorph/consolecmd/send_file_tool.go`) appears in its reply as a received-file card (`web/console-nsh/components/chat/ReceivedFile.tsx`, rendered from `ChatHistoryItem.tsx:448`): the name and a download button. Only raster images show anything more, an inline image (`canPreviewReceivedFile` in `lib/core/received-files.js`, PNG/JPEG/GIF/WebP), and the server refuses a preview of anything else (`internal/daemonruntime/console_attachments.go:174`: "file type has no preview; download it instead"). Files the user sends, and composer attachments, already open in the chat's file preview dialog (`pages/chat/FilePreviewDialog.tsx`, `components/chat/filePreview.ts` `createFilePreview`, opened by `previewComposerFile` in `pages/chat/chatController.ts:1581`), which shows images, PDFs and UTF-8 text.

1. A received file that the preview dialog can show (image, PDF, or a text file: decide the text types from the name and content type, for example `text/*`, `.md`, `.json`, `.csv`, `.log`, source files) gets a preview action on its card, beside download, and pressing the card's name opens it too. Images keep their inline picture; pressing it opens the dialog.
2. The dialog opens on that file, with the message's other previewable received files to step through, as the user's sent files do. It loads the bytes from the agent (the attachment URL), never runs them: PDFs and images as the dialog shows them today, text as text. A file the dialog cannot decode (not UTF-8, too large) says so and offers download, as the dialog does for sent files.
3. Server: `/attachments?preview=1` (or a separate fetch the dialog uses) serves the previewable types inline, still with the sandbox CSP, `nosniff` and `no-store` headers it sets today; other types keep the 400. Put a size cap on text previews.
4. A file that cannot be previewed (an archive, a binary) keeps the download button alone: no preview action that would only fail.
5. Works on the web, the desktop app and Android; on phones the dialog is the existing sheet.

Acceptance criteria:
- In a Console chat, after the agent sends a PDF, a Markdown file and a PNG with send_file, each card offers preview and the dialog shows each correctly; a .zip shows download only.
- Go tests for the attachments handler cover the newly allowed preview types and the refused ones; Console tests (`tests/`) cover the preview action and the dialog opening on a received file; `go test ./...` and the full Console test runner pass.
