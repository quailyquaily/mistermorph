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
