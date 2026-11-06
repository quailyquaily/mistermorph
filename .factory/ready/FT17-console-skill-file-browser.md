---
branch: factory/FT17-console-skill-file-browser
round: 1
---
# Explore and view all skill files in Console

## factory · 2026-11-06 15:35
Requested by the owner: "factory new a new feature, to allow to explore and view files in skills, not only for SKILL.md"

Add read-only file browsing to the Console skill detail view, so users can explore a skill's directory and view its supporting files rather than only SKILL.md.

Acceptance criteria:
- Show the selected skill's files and nested directories with clear relative paths; allow expanding directories and selecting files.
- Keep SKILL.md readily accessible and preserve the existing skill documentation view.
- Support viewing text files such as Markdown, scripts, configuration, and reference documents. Preserve formatting for source/plain text; never execute scripts or active content while previewing.
- Clearly identify unsupported binary files and files too large to preview, without freezing the UI or returning unbounded contents.
- Handle empty directories, loading, inaccessible or missing files, and read failures with clear states; switching skills must not leave stale file content visible.
- Restrict listing and reading to the selected skill's directory, including protection against path traversal and symlink escapes. Preserve existing authorization/access restrictions.
- Add regression coverage for nested browsing, non-SKILL.md text preview, error/unsupported states, and directory-boundary enforcement.

Scope: browsing and viewing only. No file editing, upload, deletion, or script execution.

## factory · plan · 2026-11-06 17:06
Behaviour: Keep SKILL.md as the default documentation view. Lazily load expanded directories and show relative file paths. Selecting a supporting text file displays escaped preformatted text; returning to SKILL.md restores its existing renderer. Clear previews and discard stale responses on skill or agent changes. Show explicit loading, empty, missing, denied, binary, too-large and failed states.

Scope: Read-only skill directory/file endpoints, Console tree and preview, translations and regression tests. No file mutation, uploads or script execution.

Decisions: Preview text up to 256 KiB; cap listings at 500 entries and scans at 2000. Refuse traversal and internal symlinks, use a rooted filesystem boundary, preserve existing authorization. Keep legacy flat-list fallback for older agents.

Checking: Go tests for nested paths, boundaries, symlinks, errors, size limits and authorization; frontend tests for tree/state handling and stale replies. Run formatting, vet, all Go tests, Console tests and production build. Browser layout remains a manual check.

## factory · 2026-11-06 17:06
Recovered the interrupted build's existing two focused commits; preserved leftover untracked artifacts in a stash. Claude Code checked completion and found no additional changes needed. Built read-only authenticated directory and file routes, expandable skill tree, safe supporting-file text preview, bounded unsupported states, request cancellation guards, and English/Chinese/Japanese labels.

Commits: 412d9296, f8458b59. Head: f8458b59. No protected paths changed. No new installs or dependency changes.

Tests: formatting check, go vet ./..., go test ./... passed; pnpm test passed (438 tests); pnpm build passed with a large-chunk warning. Manager independently reran all required checks successfully using a throwaway HOME.

Not checked: browser visual appearance and interaction have not been inspected manually. Owner should check nested directory layout, file preview styling, and returning to SKILL.md.

Pushed branch and moved new/ → review/. No merge into master.

## factory · review · 2026-11-06 17:22
head: f8458b59d539a800cf74dbc4e4c2d337ec908f91
verdict: pass
notes:
- [P2] internal/agentsettings/skills_files.go:127: Replacing a checked directory with a FIFO before root.Open can indefinitely block listing requests. A concurrent references/ directory/FIFO swap blocked 16 requests until a FIFO writer opened. Atomically reject special files with directory-only and appropriate nonblocking open flags.
- [P2] web/console/src/components/SkillFileTree.js:80: Ordinary-object node lookup mistakes inherited properties for loaded directories. Expanding constructor/guide.md skips the request and throws "node.entries is not iterable"; __proto__/guide.md appears empty. Use Map, a null-prototype dictionary, or own-property checks for all node reads.

Codex reviewed all 18 changed files in origin/master...HEAD (base 6365a87d), including authentication, traversal/symlink boundaries and preview safety. No P0/P1 findings; moved review/ → ready/ under the factory gate. The two P2 findings remain for owner consideration before shipping.

Validation: formatting check, go vet ./..., go test ./... passed; pnpm test passed (438 tests); pnpm build passed with a large-chunk warning. Targeted component reproduction and temporary Go overlay concurrency tests confirmed the findings. Scripted tests used an absolute throwaway HOME. Only pinned frontend dependencies were restored; no nonroutine installs. Worktree remained clean.

Not checked: browser visuals, live remote deployment integration, and non-Unix platforms. No linked GitHub issue or PR. No implementation changes or merge into master.
