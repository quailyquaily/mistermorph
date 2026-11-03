# Received files in Console Web

Agents can use `tool_search` to find `send_file` by name or by descriptions such as
“send a file”, “share document”, or “image attachment”. The tool sends to the
current task's conversation. The caller cannot choose another conversation.

Example parameters:

```json
{"dir_name":"workspace_dir","path":"reports/summary.pdf"}
```

`dir_name` must be `workspace_dir` (the current task's workspace) or
`file_cache_dir`. `path` must be relative to that directory. Parent-directory
escapes, absolute paths, and symlinks escaping the directory are rejected.
Files must be readable, regular, non-empty, and no larger than 64 MiB, matching
the Console upload limit. Files that `read_file` may not read may not be sent
either: `send_file` refuses paths matching `tools.read_file.deny_paths` (by
default `config.yaml`). The tool follows symlinks itself, checks the name of
every file along the way, and confirms the file it opened is the one it checked,
so swapping a link during the call cannot deliver a denied file. No new
configuration or manual setup is required.

Each received file shows its filename and a Download button. PNG, JPEG, GIF,
and WebP files have inline image previews. The server identifies these types
from their content, not their extensions. SVG, HTML, PDF, and all other types
are download-only. A failed image preview leaves the download action available.
Received files never render through an iframe or execute as a page.

The server copies file content into the Console task store's `attachments`
directory under a random identifier. It saves the attachment metadata in the
existing task journal before reporting success. Later task updates retain that
metadata. Removing or changing the source file does not affect the sent copy.
Metadata contains no absolute source paths. Missing or unreadable inputs,
invalid access, storage errors, and journal errors return tool errors.

Attachments appear during the task through the existing stream and task polling,
and are included when conversation history is loaded. The default
`tasks.persistence_targets: ["console"]` restores them after server restart.
If Console persistence is disabled, reloads within the running server still
work, but history is not restored after restart, as with other Console tasks.
There is no automatic attachment expiry or aggregate storage quota. Content is
retained alongside task history; deleting a topic hides its history and denies
new attachment requests, while its journal records and stored content remain on
disk. Include the task store and journal together in backups or manual cleanup.

The attachment endpoint uses Console's existing authentication policy and checks
that the attachment belongs to the requested task and topic. It accepts opaque
attachment IDs, not local paths. Downloads use attachment disposition and a
binary content type. Preview responses allow only the four raster image types.
Both responses use `nosniff`, a restrictive sandbox CSP, and private/no-store
cache headers. Browser previews use authenticated fetches and temporary blob
URLs, which are revoked when the component is removed.
