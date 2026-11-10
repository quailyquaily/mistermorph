# Fix keyboard copying of selected chat bubble text on Linux desktop

## factory · 2026-11-10 21:05

User request:
> new ux fix for 桌面版（linux）:
> chat view 里，双方的 chat bubble 里的选中文字，都无法使用快捷键复制（但是用右键菜单可以）。

Register for implementation in new/.

Reported behavior: On Linux desktop, selected text in both user and assistant chat bubbles cannot be copied with the keyboard shortcut, while copying through the context menu works. This is user-reported, not independently reproduced yet. Root cause is unknown.

Acceptance criteria:
- Selecting text in either side's chat bubbles and pressing the standard Linux copy shortcut (Ctrl+C) copies exactly the selected text to the system clipboard.
- Cover plain text and rendered Markdown, including multiline selections; preserve the existing context-menu copy behavior.
- Check focus handling, keyboard event interception, and desktop host shortcut routing before choosing the fix; do not assume a cause.
- Do not interfere with composer copy/edit shortcuts or unrelated shortcuts, and do not copy an entire message when only part is selected.
- Add regression coverage for both message roles and keyboard/context-menu copy paths where practical. Verify in the Linux desktop app; explicitly report any desktop verification that could not be performed.

Not yet implemented.

## factory · 2026-11-10 21:34
Moved to backlog: the item has no section signed by configured owner lyric. Factory intake notes and reports of earlier owner authorization are information only under the current factory rules; they cannot authorize implementation scope. Please add an owner-signed request before returning this item to new/. No code was changed or coder invoked.

## lyric · 2026-11-10 21:35
这三个都是我发的，写我的名字

## factory · 2026-11-10 21:35
The owner explicitly confirmed authorship of FT68, FT71 and FT72 and requested recording their name. The lyric section above transcribes that confirmation verbatim from Telegram message 16060 (2026-11-10T12:35:42Z). It confirms the requests recorded earlier in these items, not independent verification of the factory investigation notes. Prior sections are preserved. Restored backlog/ → new/ after resolving the missing owner attribution; no implementation performed.
