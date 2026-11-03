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
