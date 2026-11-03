---
branch: factory/FT3-console-send-file-tool-and-preview
round: 1
---
# Console Web: send_file tool and received-file previews

## lyric · 2026-11-03 18:05

Add a send_file tool that allows an agent to send a file to the current Console Web conversation. The tool must be discoverable through tool_search. Console Web must display received files and support previews.

### Acceptance criteria
- tool_search can discover send_file using its name and file-sending descriptions, with a usable parameter schema.
- Calling the discovered tool with a permitted local file delivers a file attachment to the intended Console conversation.
- Received attachments show their filename and a download/open action; preview supported file types inline or in a preview panel.
- At minimum, images have a visual preview; files without supported previews retain a clear download fallback. Document the supported preview types.
- Attachments and their previews remain accessible when the conversation is reloaded, according to the existing retention policy.
- Missing/unreadable files and delivery failures produce explicit tool errors rather than a success response.
- Apply existing file-access and conversation-authorization boundaries; do not expose arbitrary server paths or execute active file content in the Console origin.
- Add regression coverage for tool discovery, successful delivery, failure paths, preview rendering, and unsupported-type fallback.

## factory · plan · 2026-11-03 23:05

**Behaviour:** Discover send_file through the Console tool catalog. Validate the local file against allowed workspace/cache boundaries, bind delivery to the current conversation, persist content and metadata before success, and display attachments live and after reload. Show filenames and downloads; preview safe raster images. Reject empty, missing, unreadable, out-of-bound inputs and failed delivery explicitly. No first-run setup.

**Scope:** Console runtime registration, secure attachment storage and authenticated access, conversation persistence, frontend rendering and regression tests. Reuse existing file-access and conversation machinery. Other channels, deployments and protected paths are excluded.

**Decisions:** Conversation is implicit, never caller-overridden. Follow the existing 64 MiB upload limit and task history persistence. PNG/JPEG/GIF/WebP preview by content type; active formats and unsupported files download only. Opaque attachment IDs hide source paths. Document retention and supported formats.

**Checking:** Discovery/schema, delivery/persistence/reload, conversation authorization, traversal/symlink boundaries, missing/unreadable inputs and failed delivery, preview and fallback regressions. Run gofmt, go vet, go test, pnpm test and pnpm build with isolated HOME; visually check UI where available and record gaps.

## factory · 2026-11-03 23:05

Built and pushed commit `2eb98792` on `factory/FT3-console-send-file-tool-and-preview`; moved new/ → review/, build round 1. Merged origin/master first (already up to date). Only item-scoped changes; no protected paths changed.

Implemented deferred send_file discovery, current-conversation delivery, durable attachment content/metadata, authenticated download and raster preview endpoints, live/reloaded chat rendering and security/regression coverage. Documentation: docs/console/received-files.md. Retention follows task history; no automatic attachment expiry or aggregate quota. SVG/HTML/PDF and other unsupported types are download-only.

Installs: `pnpm --dir web/console install --frozen-lockfile` installed 83 locked packages using cache. Corepack automatically installed pnpm 12.3.4 in isolated test homes (including verification/retry). Baseline dependency check reported Already up to date and reran esbuild postinstall. No new project dependencies or system tools; no sudo.

Tests: manager independently verified `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` and `pnpm build` pass. Build has existing chunk-size warnings. `pnpm test` has 313 passes and 2 failures after retry; baseline 172bd18d has 303 passes and the identical 2 failures (temporary git archive, normalized failure output compared). Unrelated baseline failures were not changed.

Failing tests: `reasoning expands into the existing Markdown chat bubble; Skills sits after TODO in the navigation`.

The first failure is chat-reasoning-bubble.test.mjs:25 (MarkdownContent assertion true !== false); the second is skills-page.test.mjs:28 (Memories between TODO and Skills). Initial Go test environment interference cleared with isolated environment.

Coder reports desktop and 390px narrow-screen component screenshots checked. Real-model end-to-end delivery was not checked. Owner/reviewer should examine attachment authorization, retention and preview behavior and the two existing frontend failures. All contact notifications sent successfully.

## factory · review · 2026-11-04 00:02
head: 2eb98792f9a8e34f010752c2ee464d3a2394d2e5
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/send_file_tool.go:72: send_file opens and delivers files without applying the existing sensitive-file denylist (tools.read_file.deny_paths); pass and enforce that policy before reading or persisting, retaining root/symlink boundaries. Example: Codex's temporary Go overlay configured private.txt as denied; read_file rejected it, but the actual Console runtime send_file delivered it and its download returned HTTP 200 with the full test content.
- [P1] web/console/src/core/chat-reasoning-bubble.test.mjs:25: pre-existing assertion rejects MarkdownContent throughout the status card, including coder output; limit the assertion to reasoning. Example: both head and base fail with true !== false on identical status-card source.
- [P1] web/console/src/core/skills-page.test.mjs:28: pre-existing navigation assertion requires Skills immediately after TODO; reconcile with intended navigation. Example: both head and base render TODO → Memories → Skills and fail the adjacency assertion.

Codex reviewed the complete 18-file diff in origin/master...HEAD against the owner request and plan; base 172bd18d7f8b42bac97760cdf5be0c6bd9b3e05d. Read AGENTS.md, review-code and its security reference; traced discovery, delivery, persistence, authorization, path boundaries and preview rendering. The first finding is newly introduced; the other two are confirmed baseline failures classified P1 by the required test-failure rule. Remains in review/ for the owner to decide. Manager merge-tree check was conflict-free; no merge or implementation push needed.

Validation: required gofmt/vet/full Go gate passed; no SQLITE_BUSY observed. Head pnpm test: 313 passed, 2 failed; independent base snapshot: 303 passed, the same 2 failures. pnpm build passed with a chunk-size warning. Temporary Go overlay reproduced the denylist bypass without modifying repository source. Scripted tests used an isolated environment and an absolute throwaway HOME.

Installs: pnpm --dir web/console install --frozen-lockfile installed 83 locked packages; dependency-provided esbuild node install.js executed. Existing tools and Go caches reused; no additional tools or sudo. Contact notified of installations.

Residual risks: real-model end-to-end delivery, real-browser visual/download interaction and cross-platform persistence were not verified.

Reviewer made no source/lockfile changes, commits, pushes, fetches or gh calls; manager confirmed clean worktree and unchanged head. No linked GitHub issues or PRs in header or owner sections, so no review comments applicable.

## lyric · 2026-11-04 00:18

Fixed the two baseline findings on this branch, cherry-picked from FT2: `c8ca3132` updates the out-of-date frontend assertions (coder replies use MarkdownContent in the status card since `0192ad29`; Memories sits between TODO and Skills since `32ea09a8`), and `3570a8d7` fixes the intermittent journal SQLITE_BUSY on opening a new database. Full gate and `pnpm test` (315 pass, 0 fail) pass on the new head.

The deny-list finding is still open and is a real FT3 bug: `send_file` must refuse paths that `tools.read_file.deny_paths` denies, before reading or storing the file. Fix it in the next round.

## factory · review · 2026-11-04 00:57
head: 3570a8d713c7be8a93d356372c29ffcf72840762
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/send_file_tool.go:72: send_file still bypasses tools.read_file.deny_paths; pass and enforce the existing sensitive-file policy before reading or storing, retaining directory and symlink guards. Example: denying private.txt makes read_file refuse it, but actual Console runtime send_file delivers it and authenticated download returns HTTP 200 with all 28 bytes of synthetic content; reproduced for workspace and cache roots.
- [P1] internal/elevate/session.go:67: pre-existing Unix socket path-length failure in tests with a long TMPDIR; select a sufficiently short private socket directory. Example: a 73-byte TMPDIR produces a 108-byte socket address and bind: invalid argument; baseline TestSudoArgsAndEnv also fails, and shortening TMPDIR passes. Included under the mandated test-failure-is-P1 rule, not an FT3 regression; the final gate passes with corrected test environment.

Codex reviewed all 22 changed files in origin/master...HEAD against the request and plan, base 172bd18d7f8b42bac97760cdf5be0c6bd9b3e05d. Read AGENTS.md, review-code and its security reference. Merge-tree was conflict-free; no merge or code push required. Remains in review/ for the owner to decide.

Validation: initial complete Go gate failed in integration, internal/elevate and tools/builtin because of the baseline TMPDIR socket limit. With shortened TMPDIR, required gofmt/vet/go test gate passed (155 packages with passing tests). pnpm test passed 315/315; pnpm build passed with a chunk-size warning. Previous frontend failures are resolved; no SQLITE_BUSY observed. Temporary Go overlay independently confirmed the deny_paths bypass. Scripted tests used env -i and an absolute throwaway HOME.

Installs: pnpm install --frozen-lockfile installed 83 locked console packages; project-specified pnpm 12.3.4 installed automatically; dependency-provided esbuild node install.js executed. Existing Go tools/caches reused. No sudo or system packages. Contact notified of installs.

Residual risks: real-model end-to-end delivery, real-browser visual/download interaction, and non-Linux persistence were not verified. Reviewer reports no source/lockfile/protected-path changes, commits, pushes, fetches or gh calls; manager independently confirmed clean worktree and unchanged head. No linked GitHub issues or PRs in source/owner sections, so no review comments applicable.

## lyric · 2026-11-04 07:43

Fixed both findings from the 00:57 review on this branch.
- `847f880f`: `send_file` now refuses paths matching `tools.read_file.deny_paths` before reading or storing, checking the named path and a symlink's target. The runtime passes the configured list to the tool. New tests cover denied basenames, nested paths, full-path entries and symlinks in both `workspace_dir` and `file_cache_dir`, and the runtime path with `config.yaml` denied. `docs/console/received-files.md` documents it.
- `bdf2b017`: the elevate askpass socket directory moves under `/tmp` when `TMPDIR` would make the socket path longer than `sun_path` allows. `TestSocketDirWithLongTMPDIR` covers it.

The full gate passes with a 122-byte `TMPDIR` and an absolute throwaway HOME; `pnpm test` 315 pass, 0 fail. Review it again.

## factory · review · 2026-11-04 07:56
head: bdf2b0178ef4a2681b91d9dd8e416c712e5a7689
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/send_file_tool.go:86: deny_paths validation and file opening race: a symlink can change from an allowed target to a denied file inside the permitted directory after validation, before root.Open. Bind policy validation to the actual opened object through a race-safe resolution/open flow, and add concurrent symlink-swap coverage. os.Root prevents directory escape, not this in-root denylist bypass. Codex's independent overlay reproducer delivered private.txt on its fourth call and authenticated download returned HTTP 200 with the denied content.

Codex reviewed the full 25-file origin/master...HEAD diff against the request and plan; base 172bd18d. Read AGENTS.md, review-code and its security reference. Static denylist and symlink checks now pass; long TMPDIR socket fix passes. The concurrent bypass is an introduced security defect, not a baseline/environment failure. Item remains in review/ for the owner to decide. Manager merge-tree check was conflict-free; no code merge or push required.

Validation: required gofmt/vet/full Go gate passed (155 passing test packages, 17 without tests), with absolute throwaway HOME and 128-byte TMPDIR. Focused checks: 8 top-level tests and 27 subtests passed. Independent concurrency overlay test failed, proving the P1 above. pnpm test passed 315/315; pnpm build passed with chunk-size warning.

Installs: 100 Go modules downloaded into isolated cache by the Go gate; pnpm install --frozen-lockfile installed 83 locked Console packages; dependency-provided esbuild postinstall (node install.js) executed. Reused existing Go, Node and pnpm 12.3.4; no additional user-level tools, system packages or sudo. Contact notified of installs.

Residual risks: real-model end-to-end delivery, real-browser preview/download interactions, and non-Linux persistence not verified. Reviewer made no source/lockfile changes, commits, pushes, fetches or gh calls; manager verified clean worktree and unchanged HEAD. No linked issues or PRs in source/owner sections; no GitHub review comments applicable.

## lyric · 2026-11-04 08:16

Fixed the symlink race from the 07:56 review in `76628940`. `send_file` no longer checks a resolved path and then opens the link again. It follows symlinks itself within the root, one at a time (at most 16), checks every name it will open against `tools.read_file.deny_paths`, and confirms with `os.SameFile` that the opened file is the file it checked, before and after the open. A swap during the call returns an error and delivers nothing.

`TestConsoleSendFileDenyPathsSurvivesSymlinkSwaps` swaps a link between an allowed and a denied file during 2000 calls: the previous head delivered the denied file in 3 of 3 runs, this head in none. `TestConsoleSendFileFollowsSymlinkChains` covers chains, links in subdirectories, absolute links inside the root, loops and escapes.

The full gate passes with a 175-byte `TMPDIR` and an absolute throwaway HOME; `pnpm test` 315 pass, 0 fail. Review it again.
