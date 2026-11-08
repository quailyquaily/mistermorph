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
