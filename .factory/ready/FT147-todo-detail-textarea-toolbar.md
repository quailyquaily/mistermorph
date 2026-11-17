---
branch: factory/FT147-todo-detail-textarea-toolbar
round: 1
---
# Replace the Todo detail Markdown editor with a regular textarea, keeping the toolbar

## factory · 2026-11-17 23:49
Owner request: "New UI request: replace the markdown editor in the Todo detail page with a regular textarea. But the toolbar should remain and so I can still use them to insert. Put to new/"

Requirements:
- In the Console Todo detail page, replace the Markdown editor with a regular plain-text textarea.
- Keep the existing formatting/insertion toolbar visible and usable. Its actions must insert the corresponding Markdown or content into the textarea at the cursor, or apply to the selected text where appropriate.
- Keep textarea focus and cursor/selection behavior usable after toolbar actions; do not lose existing text.
- Preserve existing Todo detail loading, editing, saving, and stored Markdown content. This is an editing UI change, not a content migration.
- Preserve applicable read-only/disabled behavior and keyboard accessibility.
- Add regression coverage for textarea editing and saving, toolbar insertion at the cursor, formatting selected text, and preservation of surrounding text. Check the UI manually where possible and record any unchecked behavior.

Requested status: new. Implementation is pending.

## factory · plan · 2026-11-18 00:33
Behaviour: Show existing Todo Markdown in a normal multiline textarea, including empty content and its placeholder. Typing and saving retain the existing state and persistence flow. Keep contact/conversation insertion controls; replace the remembered selection or insert at the caret/end with existing spacing, preserve surrounding text and restore caret/focus. Cancel/errors leave content intact. Busy/read-only prevents edits. Switching documents forgets stale selection.
Scope: Todo content field, opt-in shared textarea support, minimal gallery example and regression tests. Other Markdown editors, storage, and backend are unchanged.
Decisions: Use nsh's standard multiline input, not a highlighted Editor. Omit Edit/Preview tabs only in plain-text mode; retain the existing insertion toolbar without inventing new formatting actions. Share insertion calculations across editor modes. Preserve existing height and disabled styling.
Checking: Test editing and saving exact Markdown, first-use insertion, cursor/selection replacement including reverse and multiline selections, surrounding text, locked fields and document switching. Run nsh check, the parallel Console test script and configured Go gate. Check Chrome desktop/mobile layouts when possible; record platform limits.

## factory · 2026-11-18 00:33
Built at 0ba56f2f (feat(console): a plain textarea for the TODO content, keeping its toolbar).
Changes: Todo detail uses opt-in plainText mode with the existing contact/conversation toolbar. Added documentKey selection reset and shared insertion logic. Picker opening preserves a focus-return target; insertion restores the caret. Other pages retain Markdown editors. Added a small gallery mode example and adjusted the keyboard-shortcut editor test to use Heartbeat, since ordinary textareas have no editor Ctrl+L shortcut.
Tests: nsh check passed. Console scripts/test.sh passed: 137 files, 0 failed; settings-integrations-channels passed on the script's isolated retry after concurrent failure. Configured gofmt/vet/go test gate passed, independently rerun by manager at the commit. Added 13 insertion tests plus Todo editing/saving/picker and disabled/read-only regression coverage.
Manual UI: coder reports 32 Chrome checks passing on desktop and phone viewport web builds with a stubbed API, including selections, focus, typing, saving and first-use insertion.
Not checked/limits: real Android, desktop application, Safari/Firefox, undo grouping and screen-reader operation were not checked. Web input accessible name currently comes from its placeholder rather than the wrapper label (existing nsh limitation). Phone picker may briefly show keyboard; phone cancel focus was inconsistent, without content changes. Native mobile keyboard behavior remains unchecked.
Installs: none; no manifest or lockfile changes.
Move: new/ → review/. No deployment or base merge.

## factory · review · 2026-11-18 00:53
head: 0ba56f2fca768cbb98399c56c0005db4fafbfb2e
verdict: pass
Review: Claude Code reviewed origin/master...HEAD, all 9 changed files and meaningful hunks. No findings. Branch merges cleanly with current master (77ebe88a).
Validation: configured gofmt/vet/go test gate passed; nsh check passed; Console scripts/test.sh passed (137 files, 0 failed, 273 seconds). contacts.test.tsx failed during concurrency and passed the script's isolated retry. Manager verified reviewed HEAD and clean worktree after the review.
Installs: none; existing pinned tools and cached TypeScript reused; no manifest changes.
Limits: review did not repeat browser/manual platform checks. Headless tests cannot prove actual host caret restoration after picker close; build reported Chrome desktop/phone-viewport checks. Native Android keyboard, desktop application, Safari/Firefox, screen readers and undo grouping remain unchecked. Phone keyboard may briefly appear before picker; mobile autocorrect and cancel focus remain manual-check risks, not confirmed defects.
Move: review/ → ready/. No code changes, deployment or base merge.
