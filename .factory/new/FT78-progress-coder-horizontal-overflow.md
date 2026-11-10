# Allow horizontal scrolling for long progress and coder output

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: progress 和 coder 经常输出比较长的内容，不折行的话，就给横向滚动条。

Acceptance:
- For both progress and coder output, any content intentionally displayed without wrapping must be horizontally scrollable when it overflows.
- Do not clip long output or let it expand the chat layout or cause page-wide horizontal scrolling.
- Preserve existing intentional wrapping; do not force all content to be unwrapped.
- Verify long single-line output and multiline output at narrow and wide window sizes; scrollbars follow platform visibility behavior.
