---
branch: factory/FT34-console-topic-group-heading-centering
round: 1
---
# Console: centre the contents of a foldable topic group heading

## lyric · 2026-11-08 23:17
In a foldable topic group heading (a tag group in the topic list), the elements (caret, tag icon, label, count, hairline) should sit in the middle.

Where: `groupLabel` / `groupRow` in `web/console-nsh/pages/chat/TopicSidebar.tsx`. The toggle's padding is uneven (`pt-2.5 pb-1`), so its contents sit low within its hover background.

## factory · 2026-11-09 00:05
Moved from backlog to new at the owner’s request: “Move FT 31~34 to new”.

## factory · plan · 2026-11-09 01:37
Behaviour: centre the caret, icon, label, folded count and hairline vertically in the foldable heading's hover fill, both expanded and collapsed. Empty lists, first-run and error handling remain unchanged.
Scope: foldable heading styling and a focused regression test; no changes to static headings, grouping or toggle behaviour.
Decisions: replace 10px top / 4px bottom padding with 7px on each side, keeping the total height and existing horizontal alignment.
Checking: exercise open and folded layouts, symmetry, total height and element centres; run nsh check, the Console tests and the configured Go checks. Manual visual checks should cover browser, desktop and Android.

## factory · 2026-11-09 01:37
Built and pushed commit 0739e7b1. Foldable headings now use symmetric py-[7px] padding; static headings are unchanged. Added a shared toggle class and layout regression fixture/tests for open and folded groups. The coder confirmed the tests fail with the old padding.
Installs: none.
Verification: configured gofmt, go vet ./... and go test ./... passed; nsh check passed; nsh test --web-host tests/noHost.js passed (273/273). Manager independently reran all checks with a throwaway HOME; the initial verification command timed out, and the longer rerun passed.
Not checked: no on-screen visual inspection in browser, desktop or Android; layout is covered by automated measurements only.
Moved new/ → review/ for review.

## factory · review · 2026-11-09 01:45
head: 0739e7b15cf25c71d37eb51461ef9e72202370b0
verdict: pass
No findings in origin/master...HEAD; all three changed files reviewed by Codex.
Validation: configured gofmt check, go vet ./... and go test ./... passed; nsh check passed; Console tests passed (273/273). Tests ran with an isolated absolute-path HOME. No unpinned installs. Review worktree remained clean.
Residual risks: no real browser, desktop or Android visual inspection. The added layout tests measure a View fixture using the shared styles rather than the actual TipButton.
Moved review/ → ready/; awaiting owner approval before shipping.
