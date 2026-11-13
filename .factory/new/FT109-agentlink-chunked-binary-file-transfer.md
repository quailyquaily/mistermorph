# Agent Link: stream files as chunked binary frames

## factory · 2026-11-13 18:53
Owner report: "it is not a binary stream? base64 frame is pretty slow". The owner asked for a new item after a discussion of file-transfer best practices.

Today (FT95, `docs/feat/feat_20261111_agentlink_file_transfer.md`), a file travels as base64 inside one JSON `message` frame, written as a WebSocket text frame (`internal/agentlink/conn.go`, `Attachment.Data []byte` in `internal/agentlink/attachments.go`). The sender reads the whole file into memory. A Console relay (`internal/agentlink/relay.go`) reads the whole frame, decodes it, validates it, re-encodes it and only then forwards it. The receiver decodes it again. Costs:
- The bytes are about 33% bigger on the wire.
- Through a relay the two hops run one after the other (store and forward), so a transfer takes about twice one hop's time.
- One frame of up to about 2.7 MiB occupies the runtime's single connection: other agents' messages and pings wait behind it.
- There is no progress and no resume: a drop mid-transfer resends the whole message.
- Every hop holds the whole file in memory, which is why the cap is 2 MiB.

Build a streamed transfer for peers that announce it, keeping the current path for those that do not.

Expected behavior:
- **Header and bytes separate.** A small JSON control frame starts a transfer: transfer id, message id, filename, media type, size, SHA-256. The bytes follow as binary WebSocket frames (`websocket.BinaryMessage`) of a fixed chunk size (about 64–256 KiB), each tagged with the transfer id and its offset. No file bytes in JSON or base64 on this path.
- **Interleaved, not blocking.** Ordinary text frames (messages, replies, pings, roster) keep flowing between chunks on the same connection. Bound the outstanding chunks per connection with a window the receiver acknowledges, so a fast sender cannot flood a slow relay or receiver, and the write deadlines no longer need to grow with the file size.
- **The relay streams.** A Console relay forwards each chunk to the target as it arrives and keeps a bounded number of chunks in flight; it never assembles the whole file. It still checks the header (sender, target capability, size against limits, clean filename and media type) before forwarding anything. It checks the byte count against the header, and drops the transfer and tells both ends if a chunk is out of order, too large, or past the declared size.
- **The receiver writes to disk as it goes.** Chunks go straight to the existing `.part-<random>` file under `file_cache_dir/agentlink/<sender>/` (through the same `os.Root`, 0600). SHA-256 is computed while writing and checked at the end, then the file is synced and published as now. A hash or size mismatch removes the part file and rejects the message (`attachment_store_failed` or `invalid_message`). The message is handed to the task or the waiting `agent_send` only once all its files are complete.
- **Resumable.** After a reconnect, the receiver reports how many bytes it already holds for an unfinished transfer, and the sender continues from that offset instead of from 0. Part files of abandoned transfers are still removed by the existing cleanup (after 1 hour). A transfer seen before (same transfer id) is not saved twice.
- **The sender streams from disk too.** The sender reads the file in chunks. The queue keeps the file's bytes on disk, not in memory: copy the file into the queue's own storage when it is queued, so later changes to the source do not matter, as today. The existing checks stay: allowed roots, regular file, size and SHA-256 at read time, and recipient authorization.
- **Capability and fallback.** A new capability (e.g. `files_stream`) in `hello`, copied into the relay's `roster`. Stream only when the sending runtime, every relay on the route and the target announce it; otherwise use the current base64 `attachments` path unchanged, which older runtimes and Consoles keep using.
- **Limits.** Streaming removes the memory reason for the 2 MiB cap. Raise the per-file limit for streamed transfers to a deliberate value (proposal: 64 MiB per file, 4 files per message), still fixed constants, not config. Revisit the queue (16 MiB), relay in-flight (32 MiB) and inbox (64 MiB / 256 files / 7 days) bounds so they still make sense: queued and inbox bytes are on disk, relay bytes are chunks in flight. Check the header against every limit before accepting any bytes. Keep the old path at 2 MiB.
- **Progress.** Expose bytes sent and received per transfer where the runtime already reports Agent Link activity (logs at least). A Console UI for it is out of scope.
- **Unchanged:** files in answers (`ReplyFiles`, `attached_to_reply`), the task note with saved paths, untrusted-file handling, `unauthorized` / `files_unsupported` semantics, `queue_ttl` expiry, and the tool interface of `agent_send` and `contacts_send` (except the larger size limit on streamed routes; their errors must say which limit applied).

Tests (`internal/agentlink/`, extending `attachments_test.go` or alongside it):
- Direct and through a relay: binary, empty, exactly chunk-sized, one byte over, and largest files; text frames delivered while a large transfer is under way.
- A relay never holding more than its window: assert on its buffered bytes.
- Resume after a dropped connection mid-transfer, from the receiver's offset, with no duplicate file.
- Corrupt, out-of-order, oversized, and short chunks rejected with the part file removed.
- Mixed versions: new↔old runtime and new runtime through an old relay fall back to base64; an old runtime never receives binary frames.
- A benchmark comparing the old and new paths for a 2 MiB file through a relay (wall time and peak memory), with the numbers recorded in the doc.

Update `docs/feat/feat_20261111_agentlink_file_transfer.md` (protocol, limits, compatibility) or add a follow-up doc that it links to.
