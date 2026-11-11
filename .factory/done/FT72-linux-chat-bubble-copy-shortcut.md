---
branch: factory/FT72-linux-chat-bubble-copy-shortcut
round: 1
---
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

## factory · plan · 2026-11-11 00:06
Behaviour: Ctrl+C copies exactly the selected portion of either chat bubble, including plain text, rendered Markdown and multiline selections. Empty selections do not copy a whole message. Context-menu copy and composer editing remain intact; no first-run setup.
Scope: investigate native focus, keyboard routing and selection handling; minimally fix the desktop host and add regression tests. No unrelated UI changes.
Decisions: reuse native selected text, not message-content fallbacks; identify the dispatch defect before changing it.
Checking: exercise bubble and standalone selection, composer routing and context-menu parity; run required Go checks and relevant native tests. Run Console checks if Console sources change. Report unavailable live desktop verification.

## factory · 2026-11-11 00:06
Built and pushed 6183b6a4. The focused composer consumed Ctrl+C before page selection handlers. Native input now lets copy reach a nonempty page selection when the field has no selection; selecting bubble text collapses a stale field selection without losing composer focus. Added a simulated-window regression covering sent text, Markdown multiline partial selection, standalone text, Ctrl+Insert, context-menu parity, composer copy/typing and empty selections. Recorded the vendored fix as a patch and documented it.
Required checks: gofmt, go vet ./..., go test ./... passed, independently rerun by manager with throwaway HOME. Coder reports desktop cargo test: 66 passed, 4 ignored. Vendored library: 208 passed, 4 failures also reproduced on unchanged base (missing fixtures/fonts); new regression fails on old code and passes with fix. These existing native-suite failures remain, not fixed by this item.
Installs: none; reused an existing test-font fixture in item scratch space. No Console source changes, so nsh checks were not required.
Not checked: running Linux desktop UI/system clipboard in a real graphical session; no usable X/Wayland display or Xvfb. Simulated-window coverage is not live desktop verification. Owner/reviewer should check Ctrl+C in both bubble roles on Linux.
Move: new/ → review/. No merge or release performed.

## factory · review · 2026-11-11 00:21
head: 6183b6a4fbd0c42fdac37617758ab75126f0131b
verdict: pass

Claude Code reviewed all eight changed files in origin/master...HEAD; no introduced P0/P1/P2/P3 defects found. Branch merges cleanly with base; worktree remained clean.
Validation: required gofmt, go vet ./..., and go test ./... passed with throwaway HOME. Desktop cargo tests: 66 passed, 4 ignored. Vendored native tests: 208 passed, four missing-image/font-fixture failures reproduced on unchanged base. The new simulated-window regression passes on HEAD and fails on base (clipboard retained "-" instead of "alpha"). Patch reproduces vendored changes byte for byte. Additional scratch-only probes covered composer paste, undo, cut, select-all, copy precedence, double-click selection and selection clearing. No forbidden paths or Console sources changed; Console checks not applicable.
Residual risks: no live Linux graphical session or real system clipboard verification; owner should check Ctrl+C for both bubble roles. Cross-code-block selections and streaming selections were not tested. Existing native fixture failures remain, unrelated to this change.
Installs: none. No linked GitHub issues or PRs to comment on.
Move: review/ → ready/. No merge or release performed.

## factory · 2026-11-11 12:33

Owner-authorized ship with Claude Code: FT68, FT72, fixed FT74 and FT75. Merge: 5fc3f308; combined master b8a014eb1a44f5e57656296cc38360e4f527d4f3 pushed. No tag created or pushed, as explicitly requested. 

Combined validation: gofmt cleanliness, go vet ./..., go test ./..., nsh check, Console tests 611/611, core Node 259/259, Android manifest 6/6 and web build passed. Tests used isolated HOME/XDG directories. Manager inspected diffs and suite logs; did not independently rerun suites. FT72 Rust/native suites not rerun in this ship; previously recorded four baseline fixture failures remain. No browser visual or native device validation this round. No installs. No linked GitHub issue or PR. Moved ready/ → done/.
