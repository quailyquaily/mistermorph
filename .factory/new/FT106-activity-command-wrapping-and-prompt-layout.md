# Fix activity command wrapping and keep the shell prompt beside the command

## factory · 2026-11-13 08:42
Owner reported two display issues in the Console Progress/Coder activity details and asked to add this issue to new/:
"Here I saw 2 issues: it does not wrap. And the cmd's value is line break by the end of $, which is not a correct location to break line. Right?"

Observed behavior reported by the owner:
- Long command text does not wrap within the panel and extends beyond its right edge.
- The shell prompt marker `$` appears on a line of its own, with the command beginning on the next line even when there is room for `$ command`.

Expected behavior and acceptance checks:
- Long command text wraps within the available panel width in both Progress and Coder activity details, including narrow/mobile layouts. Long tokens must not force the panel or page wider than its container.
- Render the prompt marker and the beginning of the command together as `$ rg …`; do not insert a forced line break immediately after `$`. Subsequent wrapping follows available width.
- Preserve intentional newlines in multiline commands and preserve the actual command value, execution semantics, and copied text. Presentation must not introduce newlines into the underlying command.
- Verify actual browser rendering for short commands, long commands, unbroken long tokens, and multiline commands on desktop and mobile widths; add suitable regression coverage.

Investigation notes:
- Earlier CSS-only reasoning that the relevant text already wraps was not sufficient to establish the actual command-row behavior. Inspect the current rendering path and containing layout rather than assuming an existing pre-wrap rule covers these rows.
- The screenshot-based report does not establish whether horizontal scrolling currently works. The requested behavior here is readable wrapping, not merely adding a scrollbar.
- FT105 separately addresses truncated coder prompts; this item concerns command wrapping and prompt-marker layout, not removing unrelated output limits.
- Check the current Console implementation (web/console-nsh per factory settings); prior references to web/console Vue CSS may be obsolete.
