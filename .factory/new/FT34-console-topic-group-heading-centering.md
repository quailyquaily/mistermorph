# Console: centre the contents of a foldable topic group heading

## lyric · 2026-11-08 23:17
In a foldable topic group heading (a tag group in the topic list), the elements (caret, tag icon, label, count, hairline) should sit in the middle.

Where: `groupLabel` / `groupRow` in `web/console-nsh/pages/chat/TopicSidebar.tsx`. The toggle's padding is uneven (`pt-2.5 pb-1`), so its contents sit low within its hover background.

## factory · 2026-11-09 00:05
Moved from backlog to new at the owner’s request: “Move FT 31~34 to new”.
