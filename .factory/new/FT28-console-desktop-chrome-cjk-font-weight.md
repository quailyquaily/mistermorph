# Fix unexpectedly bold CJK text in desktop Chrome chat view

## factory · 2026-11-08 12:50
Registered from the owner's report:
> new factory UI bugs, on Web PC View (Chrome Desktop) only:
> 1. the CJK font on Chatview seems not correct, all CJK characters become the bold.

Scope: desktop web chat view in Google Chrome only. Ordinary Chinese, Japanese, and Korean characters reportedly appear bold when they should use the normal body-text weight. The cause is not yet diagnosed.

Acceptance criteria:
- Reproduce and inspect the actual font selection, fallback, loaded font faces, and computed font weight before choosing a fix; do not assume a cause from the report alone.
- Ordinary CJK chat text renders at the intended normal weight, including mixed CJK/Latin messages; intentionally bold Markdown remains bold.
- Preserve existing mobile styling and other browser behavior; avoid an unrelated global typography redesign.
- Add appropriate regression coverage and visually verify desktop Chrome with Chinese, Japanese, Korean, mixed-script, and explicitly bold text. Record the tested environment and any verification limitations.

Request registered only; not diagnosed or implemented.
