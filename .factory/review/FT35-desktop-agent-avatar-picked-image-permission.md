---
branch: factory/FT35-desktop-agent-avatar-picked-image-permission
round: 1
---
# Fix desktop agent avatar replacement failing to load the picked image

## factory · 2026-11-08 23:38
Owner requested a new bug item for the desktop version.

When replacing an agent avatar with a picked local image, the operation fails with:

```text
could not load the picked image: Image.getSize / prefetch of file:///PATH/TO/THE/IMAGE.png is not granted: add `file:///PATH/TO/THE/IMAGE.png` to capabilities.network in nsh.json
```

Expected: a user-selected image can be loaded and used to replace the agent avatar in the desktop app without manually adding individual file URLs to nsh.json.

Investigate the desktop picker-to-image-loading permission flow; the root cause is not yet confirmed. Preserve capability restrictions and avoid granting unrestricted local-file access as a workaround. Verify successful avatar replacement with a selected PNG, graceful cancellation and invalid-image errors, and regression coverage for the selected-file loading path. Scope: desktop; do not change mobile/web behavior unnecessarily.

Registered only; not diagnosed or implemented.

## factory · plan · 2026-11-08 23:54
Behaviour: explicitly picked images load for size, preview and avatar upload without a manual capability grant. Cancellation preserves the current avatar. Invalid images use existing errors. Unselected local files remain inaccessible.
Scope: desktop picker-to-preview permission integration and regression tests; leave web/mobile and capability declarations unchanged.
Decisions: prefer authorized selected bytes over wildcard file permissions; bound preview memory and avoid a dependency upgrade.
Checking: selected PNG preview and decoded dimensions, nonselected file denial, cancellation, invalid images, filters and bounded reads; required Go checks and desktop Rust tests. Real desktop avatar replacement must also be checked manually.

## factory · 2026-11-08 23:54
Built ecb2f6f7: picked desktop images now use data URIs instead of file URLs; permission guards remain unchanged. Preview reads are capped at 16 MiB (the console's avatar input cap is 10 MB). Extracted picker response handling for cancellation/filter regression tests and documented the preview contract.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with a throwaway HOME. Coder reported `cargo test --locked`: 50 passed, 1 ignored; `cargo build --locked` passed. Console sources unchanged, so nsh checks were not required.
Installs: only pinned Rust toolchain 1.99.1 and locked crates restored; no new dependencies or manifest changes. Coder used temporary pkg-config metadata and library links against existing runtime libraries to replace missing development metadata, then removed them; no system packages installed. Coder reported temporary files outside the run directory, contrary to the requested directory boundary; these were reported removed. Retained Rust build cache is about 8.5 GB.
Not checked: real desktop GUI avatar replacement, GPUI Image.getSize/data-URI rendering end-to-end, macOS/Windows dialogs; the ignored test requires a real built backend. Tests verify permission acceptance and image decoding, not a live GUI upload.
Moved new/ → review/ for review; not merged into master.
