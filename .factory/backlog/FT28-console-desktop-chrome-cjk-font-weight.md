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

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## lyric · 2026-11-08 18:04

FT29,28 放到 new

## factory · 2026-11-08 19:13
Moved to backlog: blocked after two Claude Code attempts; no code changes or commits. The required reproduction needs the owner desktop OS/Chrome/font environment, unavailable on this Linux host. Headless Chrome 157 rendered Chinese, Japanese, Korean and mixed text at weight 400 using Noto Sans CJK Regular; explicit bold rendered at 600 with Bold. First attempt inspected real chat components, computed styles and CDP rendered fonts and screenshots, including mobile, empty and blocked-font cases. This was a temporary component page, not the full live application. No Safari/Firefox or owner-environment verification. Owner OS/Chrome versions and DevTools Rendered Fonts/computed weight are needed to establish the defect before choosing a fix. No unpinned installs. First attempt reported pnpm test (519 passed), pnpm build and configured Go tests passed on unchanged code; retry made no changes and did not rerun tests.
