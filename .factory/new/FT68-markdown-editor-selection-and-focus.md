# Fix Markdown editor word selection and blank-area focus

## factory · 2026-11-10 14:14
Owner reports that the current Console Markdown editor cannot select a word on double-click, and that only the first line and lines containing text respond to focus clicks. Owner requests adding this UX issue to new.

Scope: the nsh Console Markdown editor wrapper (`web/console-nsh/components/shared/MarkdownEditor.tsx`) and its interaction with `nsh/base` Editor. Diagnose whether the failure belongs to our integration or the upstream editor before choosing the smallest reliable fix; do not replace the editor by default.

Investigation notes (hypotheses from prior source inspection, not browser-verified root causes):
- With `scrollBeyondLastLine={false}`, the text-line hit area may follow content height instead of filling the visible editor, leaving blank space below the last line unresponsive.
- nsh reportedly implements double-click word selection and triple-click line selection. Check click counts, event propagation, and subsequent selection resets rather than assuming missing support.
- Distinguish empty lines between paragraphs from blank space below the final line; the same cause may not explain both.

Acceptance criteria:
- Reproduce and compare a minimal plain Editor with our MarkdownEditor wrapper using identical content; record which layer causes each failure.
- Double-clicking a word selects it and preserves the selection for normal copy/replacement; ordinary single-click caret placement and drag selection continue working.
- Clicking an empty document, an empty line between text lines, the space to the right of text, or visible blank space below the last line focuses the editor and places the caret at a sensible corresponding position (document end below the final line).
- Verify short and multiline content, a scrolled document, and the current padding/layout with `scrollBeyondLastLine={false}`. Do not rely on enabling extra scroll space merely to hide the hit-area problem.
- Preserve editing, keyboard selection, Markdown preview switching, reference insertion, and touch focus behavior. Read-only editors must remain read-only.
- Add regression tests for the identified causes and exercise real browser pointer interactions; explicitly list any browser or Android host behavior not verified. If an upstream fix is required, document the dependency fix or minimal local workaround and its scope.

Registered only; implementation and browser verification have not started. Root cause remains unconfirmed.

## factory · 2026-11-10 16:52
Moved to backlog: this item contains only a factory intake section and no section signed by configured owner lyric. Non-owner sections are information only; there is no authorized implementation scope. Add an owner-signed request before returning it to new/. No implementation was attempted.

## factory · 2026-11-10 20:42
Owner explicitly confirms desktop reproduction and requests returning FT68 to new/: “FT68 我在桌面版也复现了。加到 new”. This is direct owner authorization in the current conversation to implement the existing FT68 scope; the earlier lack-of-authorization blocker is superseded by this request. Recorded by factory without impersonating an owner signature.

Move backlog/ → new/. Include the desktop host in reproduction and regression verification, alongside the plain Editor versus MarkdownEditor comparison. Desktop reproduction is owner-reported, not independently verified by factory; the exact failing interactions and root causes still require verification. No implementation was performed in this update.

## factory · 2026-11-10 21:34
Moved to backlog: the item has no section signed by configured owner lyric. Factory intake notes and reports of earlier owner authorization are information only under the current factory rules; they cannot authorize implementation scope. Please add an owner-signed request before returning this item to new/. No code was changed or coder invoked.

## lyric · 2026-11-10 21:35
这三个都是我发的，写我的名字

## factory · 2026-11-10 21:35
The owner explicitly confirmed authorship of FT68, FT71 and FT72 and requested recording their name. The lyric section above transcribes that confirmation verbatim from Telegram message 16060 (2026-11-10T12:35:42Z). It confirms the requests recorded earlier in these items, not independent verification of the factory investigation notes. Prior sections are preserved. Restored backlog/ → new/ after resolving the missing owner attribution; no implementation performed.
