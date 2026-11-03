---
branch: factory/FT1-console-clipboard-and-file-drop
round: 1
---
# Console Web: paste images and drag-and-drop files

## lyric · 2026-11-03 18:05

Support pasting images from the clipboard and dragging and dropping files into the Console Web conversation composer.

### Acceptance criteria
- Pasting clipboard image data attaches the image to the outgoing message; ordinary text paste continues to work.
- Dropping one or more files into the composer attaches them without navigating the browser away from the conversation.
- Show pending attachments before sending and allow users to remove them.
- Sending delivers the attachments to the agent, not just their names or browser-local URLs.
- Show actionable errors for failed uploads or unsupported files, preserving the draft and allowing retry.
- Cover clipboard image paste, file drop, attachment removal, and the send/error paths with appropriate regression tests.

## factory · plan · 2026-11-03 18:31

**Behaviour:** Paste clipboard images while preserving ordinary text paste; drop multiple files without browser navigation; show removable pending attachments and submit real uploaded file references. Preserve drafts and attachments on errors with upload retry. Empty inputs are no-ops; reuse the existing first-conversation upload path.

**Scope:** Reuse ChatComposer, ChatView, composer-file helpers and existing upload/file-reference infrastructure. Do not implement FT2 reactions or FT3 send_file.

**Decisions:** Keep existing upload limits and access policy, existing attachment presentation, and captured endpoint/topic scope for asynchronous work.

**Checking:** Regression tests for image and ordinary-text paste, drops, removal, retry, failed sends and file references; frontend tests and pnpm build; required gofmt, go vet and go test gate. Browser interaction and visual checks remain unperformed.

## factory · question · 2026-11-03 18:31

Build stopped before push. Local branch `factory/FT1-console-clipboard-and-file-drop` holds commit `68a9514b`; no implementation branch was pushed and the item remains in new/. Clipboard image paste, upload retry, failed-send draft preservation and regression coverage were implemented.

Factory verification: gofmt and go vet passed; go test failed. `TestLoadKeystoreRejectsGroupReadablePrivateKey: LoadKeystore() expected insecure permission error` also fails on master. This unrelated baseline failure was not changed. Node and pnpm are unavailable, so frontend tests and pnpm build could not run. A coding-agent retry did not clear the blockers; its relative-HOME retry was not accepted as valid verification. Browser clipboard/drop and visual checks were not performed.

1. Can you provide Node/pnpm and the existing frontend dependencies in the factory environment without requiring this job to install them? Default: wait, then run frontend tests and pnpm build before pushing.
2. Can you resolve the baseline keystore permission-test failure in master or the test environment and confirm a clean test environment? Default: leave unrelated code unchanged and rerun the full gate with an absolute throwaway HOME before pushing.

## factory · 2026-11-03 21:57

Migrated to the new factory workflow. The factory no longer waits for answers: the questions above are withdrawn. The coder installs missing project dependencies (Node packages via pnpm) itself, and failures that also occur on base are recorded, not fixed on this branch. The earlier local commit `68a9514b` was never pushed and is not reachable, so the next build starts fresh from base, following the plan above.

## factory · plan · 2026-11-03 22:25

**Behaviour:** Paste image data while preserving ordinary text paste; upload dropped files without navigation; show removable pending files, retry failed uploads, preserve drafts after failed sends, and send server file references. Empty inputs are no-ops; retain first-conversation support.

**Scope:** Existing composer, chat view, attachment helpers, translations and regression tests only. Preserve existing drop handling; exclude FT2 and FT3.

**Decisions:** Retain upload limits and access policy; capture endpoint/topic scope for asynchronous work. Failed attachments block sending until retried or removed.

**Checking:** Image/text paste, multiple drops, removal, retry, send/error and file-reference regressions; full Go gate, pnpm test and build. Browser visual and live-agent checks not performed.

## factory · 2026-11-03 22:25

Built round 1 at `3a50a38c` from `origin/master` (`65345643`). Base merge was already up to date. Implemented clipboard images, retryable attachments, preserved failed-send drafts, and scoped asynchronous updates; added 16 passing regression tests. Manager verified the commit scope and protected paths were unchanged.

Installed 83 frontend dependencies with `pnpm --dir web/console install --frozen-lockfile --store-dir "$PWD/.pnpm-store"`, using an absolute throwaway HOME and cache. Corepack also installed pnpm 12.3.4; Node and Go were already available. No sudo or system installs.

Required `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed, independently verified by manager with clean environment and absolute throwaway HOME. Initial inherited application environment interference cleared with environment isolation.

`pnpm --dir web/console test`: 319 passed, 2 failed, reproduced by manager. The coder's isolated origin/master snapshot had 303 passed and the same 2 failures; unrelated baseline code was not changed:
- `reasoning expands into the existing Markdown chat bubble`
- `Skills sits after TODO in the navigation`

`pnpm --dir web/console build` passed for coder and manager, with a chunk-size warning. UI changed; browser visual checks and real-agent end-to-end manual delivery were not performed. Review should inspect clipboard/drop behaviour and the two baseline failures.

Implementation branch pushed. Moved `new/` → `review/`. Contact notified of start, installations and remaining baseline failures.
