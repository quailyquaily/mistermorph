# Console: show coder output as plain monospace text in progress

## lyric · 2026-11-03 22:27

In the chat progress panel, `$coder` output (Codex and Claude Code) is rendered as Markdown (`MarkdownContent` in `web/console/src/components/ChatStatusCard.js`). Show it as plain text in the monospace font instead, the same way the other activity output is shown.

### Acceptance criteria
- Coder output in the progress panel is plain text in the same monospace style as other tool output; Markdown syntax shows as written, not rendered.
- Line breaks and indentation are kept; long output wraps or scrolls like other activity output.
- The coder-specific Markdown styling for the dark progress surface is removed if nothing else uses it.
- The final assistant reply in the chat is unchanged.
