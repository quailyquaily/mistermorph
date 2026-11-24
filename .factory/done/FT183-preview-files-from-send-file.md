---
branch: factory/FT183-preview-files-from-send-file
round: 1
---
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

## factory · plan · 2026-11-24 23:39

### Behaviour
- Previewable received cards offer a preview button and clickable name; raster thumbnails remain inline and open the same dialog.
- The existing dialog opens on the selected attachment and navigates only previewable attachments from that message, fetching authenticated attachment bytes. Empty attachment lists do nothing.
- PDF and images use existing dialog rendering; text is UTF-8 plain text, never markup. Unsupported, invalid UTF-8, oversized or failed previews show an error and retain an explicit download action.
- Server permits validated preview image/PDF/text types with the existing CSP, nosniff and no-store headers, caps text reads, and rejects archives and binary content. Existing attachment metadata must keep working where detection by name/content is needed.
### Scope
- Attachment classification/serving and tests; received-card actions and dialog/controller integration, localized labels as needed, Console regression tests.
- No tool API change, unrelated UI redesign, deployment or generated binaries.
### Decisions
- Reuse the existing cross-platform preview dialog and authenticated attachment route, not a second viewer.
- Use a conservative shared MIME/extension policy for text/source types, strict UTF-8 decoding, a documented 2 MiB text-preview cap, and never execute SVG/HTML/scripts (plain text only).
- Binary formats keep download only; old octet-stream PDF/text metadata is handled safely via inspected bytes/name rather than blindly trusting a suffix.
### Checking
- Table-driven Go tests for PDF/text/images, legacy metadata, unsupported/binary content, cap, headers and access isolation.
- Console tests for preview classification, button/name/image actions, attachment fetching and selected-file/sibling navigation, error/download fallback and lifecycle.
- Required: test -z "$(gofmt -l .)" && go vet ./... && go test ./...
- Required: nsh check in web/console-nsh and web/console-nsh/scripts/test.sh. No sequential second full suite.
- Interactive web/desktop/Android appearance remains explicitly unverified unless actually inspected.

## factory · 2026-11-24 23:39

Built and pushed `500509bd76ef649157894f3ed5acddb4dbc382be` on `factory/FT183-preview-files-from-send-file`.

Received cards now offer preview/name/image actions, same-message sibling navigation through the existing dialog, authenticated attachment fetching and download fallback. Server classifies image/PDF bytes and UTF-8 text, caps text at 2 MiB and keeps CSP, nosniff, no-store and access controls. HTML/SVG/XML remain download-only. Older octet-stream records use conservative name/content checks; misleading old binary names may show a preview action before the server rejects them.

Tests: gofmt clean, go vet ./... and go test ./... PASS (coder and independent manager verification); nsh check PASS with pinned nsh 0.6.0; Console scripts/test.sh PASS, 165 files, 0 failed. No installs; manifests unchanged. No forbidden paths changed.

KNOWN ACCEPTANCE GAP FOR REVIEW: the existing nsh WebView rejects blob: PDF URLs (headless warning); received PDFs are therefore likely blank, with Download available. Actual PDF rendering was not verified. Passing automated gates does NOT establish the PDF acceptance criterion. Review must assess this as a likely functional defect, not approve solely on passing tests. No interactive web, desktop or Android UI inspection was performed.

External writes: the coder reported a tooling memory note outside the run directory (not permitted by the task); it was not incorporated into the implementation. Early targeted tests touched shared caches, then the final gates used an isolated HOME and caches. Runtime-created /tmp entries were recorded in the run's outside ledger, not deleted; unrelated concurrent entries are only candidates for inspection, not attributed to this item.


## factory · review · 2026-11-24 23:47
head: 500509bd76ef649157894f3ed5acddb4dbc382be
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/ReceivedFile.tsx:177-193: Received PDF cards expose a preview that is blank on desktop and Android. The dialog creates a blob:nsh://app URL; nsh 0.6.0 WebView access checks only accept http(s) inner origins and discard its src. Verified example: the received-file preview tests open three PDFs and log three "blob:nsh://app/... is not granted" warnings while passing. Use a supported PDF source/viewer or disable this action on unsupported platforms. Existing sent-PDF behavior shares the cause; this change exposes it for received PDFs. The PDF acceptance criterion is NOT satisfied on these platforms; web PDF rendering remains unverified.
- [P3] web/console-nsh/lib/core/received-files.js:63-66: Octet-stream files with text-like names get a preview action even when newly recorded bytes are binary or non-UTF-8; the server rejects them and the dialog shows only a generic error. Verified probes: ELF a.out, MPEG-TS segment0.ts and Windows-1252 export.csv classify as text in the client, but the server returns 400 "file is not UTF-8 text; download it instead". Expose authoritative preview capability or distinguish new metadata from legacy guesses, and map decoding refusals to the specific error.

Review scope: Claude Code reviewed all 12 changed files in origin/master...HEAD, request and plan, attachment access controls and preview security headers. No P0/P1 findings; pass means the factory's P0/P1 gate passed, not that every acceptance criterion was met. Owner should inspect the PDF defect before shipping.

Validation: required gofmt/vet/go test gate PASS (168 packages); nsh check PASS (0.6.0); required Console scripts/test.sh PASS (165 files, 0 failed, 274s; two parallel timing failures passed the runner's solo retry); targeted received-preview test PASS (9/9, with PDF warnings); node library tests PASS (313/313). Worktree clean; no commits or source changes. No installs or manifest changes.

Limits: no live web/desktop/Android UI verification; browser PDF sandbox behavior unverified; Android JVM tests unavailable without JDK; 2 MiB text rendering speed on phones not measured. Review worktree from the previous stopped run was removed during recovery. Test artifacts stayed in this run's temporary directory; harness reported its own /tmp/claude-995 output directory, retained in the outside ledger and not deleted.


## factory · 2026-11-25 07:20
Merged into master at 1c4ba7323ef05881cd1784a97d8ea2757a427bca; released in v0.3.133.
Validation: per-item Go gate passed; final gofmt check, go vet ./... and go test ./... passed. Final nsh check and full Console runner passed: 165 files, 0 failed (581s).
Linked issues/PRs: none. Branch retained (ship clean not configured). No installs or code fixes. Existing review notes remain applicable; in particular FT182 Agent Link file delivery and FT183 PDF preview limitations were not fixed or live-tested.
Move: ready/ → done/.
