# Workspace right panel: home shorthand and single-line middle truncation

## factory · 2026-11-11 13:08
Recorded from the owner’s UI fix request.

Request:
> The workspace right panel, use ~ to indicate the home folder, keep the path in one row, do not wrap. If there are too many characters, use "..." in the middle of the full path

Acceptance criteria:
- In the workspace right panel, display the workspace home directory as `~` and descendants as `~/...`, using the relevant workspace host's home directory rather than assuming the client's home.
- Only abbreviate the actual home directory or its descendants; do not replace unrelated matching path substrings or sibling paths with similar prefixes.
- Keep the displayed path on one line without wrapping or overflowing the panel.
- When the available width is insufficient, truncate the middle with literal `...`, retaining the beginning and end of the path. Adapt when the panel width changes; leave paths that fit untruncated.
- This is a display change only: retain the original full path for filesystem operations and any existing copy/open actions.
- Test home, home descendant, non-home, short and long paths, and narrow/resized panel widths. Check web and Android app rendering; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.
