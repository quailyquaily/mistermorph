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
