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
