# File transfer support for Agent Link

## factory · 2026-11-11 20:02
Recorded from the owner's request:
> New feature request: add file transfer support for agent link. So they can share files.

Acceptance criteria:
- Agents connected through Agent Link can send files to one another, including files accompanying a text message and files returned in a reply. Extend the existing agent-send interface rather than requiring a separate manual transfer workflow.
- Transfer the actual bytes; a path on the sender's machine alone is not sufficient. The receiving agent gets attachment metadata and a usable local file reference within its allowed storage, even when agents do not share a filesystem.
- Preserve the original display filename, media type and byte size, and verify transfer integrity. Support binary files and zero-byte files without corrupting their contents.
- Use the existing authenticated Agent Link connection and recipient authorization. Do not expose public download links, credentials or arbitrary local filesystem access. Treat filenames and metadata as untrusted: prevent traversal, unsafe overwrites and accidental execution.
- Define and document bounded file size, transfer resource usage and temporary-file lifetime. Reject oversized or unreadable files clearly; interrupted, expired or failed transfers must not be reported as delivered or leave partially received files available as complete attachments.
- Keep existing text-only messaging, routing and reply behavior working. Handle peers without file-transfer support with an explicit unsupported error rather than silently dropping attachments.
- Add regression tests covering successful cross-agent transfer, byte integrity, text with attachments, reply attachments, empty files, unsafe filenames, size limits, unauthorized access, interrupted transfers and unsupported peers. Document the tool interface, limits, cleanup and failure behavior.

Scope decisions for implementation:
- Start with file attachments over Agent Link only; shared folders, directory synchronization and other messaging-channel attachment support are out of scope.
- Reuse existing attachment/cache facilities where suitable. Choose the simplest bounded transfer mechanism consistent with the current transport; avoid adding an external storage service unless demonstrably necessary.
- This records the feature request only; no implementation, merge or release is performed by this intake task.
