---
branch: factory/FT109-agentlink-chunked-binary-file-transfer
round: 1
---
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

## factory · plan · 2026-11-13 19:36

Behaviour
- Advertise files_stream only with complete streaming support. Negotiate sender, relay route and receiver; retain the existing inline files protocol and its 2 MiB limit unchanged on mixed routes.
- Queue a private disk snapshot with checked size/digest and regular-file/root authorization; stream immutable queued data in 64 KiB chunks with transfer ID and offset, separate JSON metadata, bounded receiver-acknowledged window, fixed per-chunk deadlines and ordinary frame interleaving.
- Authenticate/validate complete message metadata before accepting bytes, including empty files, aggregate and per-file limits, cleaned names/media and existing reply authorization. Relay forwards bounded chunks without assembling files, rejects invalid offsets/lengths and notifies both endpoints.
- Receiver writes rooted 0600 parts, hashes incrementally, syncs/publishes only after verified sizes/digests, removes corrupt parts, and delivers once all attachments finish. Resume valid unfinished IDs at the receiver's offset on reconnect; never publish a duplicate; retain one-hour abandoned part cleanup and queue TTL.
- Log transfer byte progress, retain reply-file/task-note/untrusted-file behavior, report the applicable route limit in tools.
Scope
- Agent Link connection/protocol/node/relay/inbox/queue and necessary tool file preparation, regression tests, and linked English protocol documentation. No Console UI or config knobs; no forbidden paths.
Decisions
- Default 64 KiB chunks and four outstanding chunks per connection, with explicit bounded transfer concurrency and byte accounting; explain any necessary adjustment. Stream limit 64 MiB per file, four per message (256 MiB total); disk queue and inbox bounds must admit a full message with bounded concurrency (choose/document deliberate constants, reserve before receiving, keep 256 files/seven days). Legacy limits remain unchanged.
- Transfer identity and resume bind sender, recipient, message and immutable metadata/digest; no trusting an arbitrary reconnect offset. Reconnect resume is mandatory; choose durable metadata where existing persistence requires restart survival and document lifetime. Reject malformed or unsupported binary frames without exposing files to old peers.
Checking
- Go formatting, go vet ./..., go test ./... with throwaway absolute HOME; focused tests for direct and relay byte boundaries including maximum, interleaving, bounded buffers/window, disconnect/resume/no duplicate, corrupt/out-of-order/oversized/short chunks and cleanup, queue source mutation, authorization/limits, and mixed-version fallback. Run real WebSocket binary-frame tests, not only Pipe.
- Add/run old versus new 2 MiB relay benchmark, record measured timings and memory (distinguish allocations from peak memory honestly). Update existing feature doc or link follow-up with negotiation, binary layout, limits, error/resume semantics and benchmark environment. No UI changes planned; report checks impossible in this environment.

## factory · 2026-11-13 19:36

Built in 292e727b, 2da85e67 and b5e4c417 (head b5e4c417): capability-negotiated binary streaming, 64 KiB chunks, four outstanding chunks per connection, end-to-end acknowledgements, streaming relay, rooted private receiver parts, incremental hash verification, disk queue snapshots, reconnect resume, progress logs and route-aware tool limits. Mixed-version routes retain the legacy base64 protocol and 2 MiB aggregate limit.

Decisions: streamed per-file limit 64 MiB, four files/256 MiB per message, disk queue and inbox 512 MiB; at most four unfinished receiver deliveries and 256 MiB reserved bytes. Receiver resume state is in memory: reconnects and sender/Console restarts resume; receiver restarts start at zero and abandoned parts age out after one hour. Four-chunk end-to-end window trades high-latency throughput for bounded memory. Older runtimes skip streamed queue entries on downgrade.

Installs: none outside repository-pinned dependencies; no manifest/lock changes.

Checks: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with an absolute throwaway HOME. Coder also reports eight repeated agentlink suite runs, race tests for agentlink/tools/runtime and 40 repetitions of the interrupted-delivery cleanup test. Tests cover real WebSocket binary frames, direct/relay boundaries through 64 MiB, interleaving, window enforcement, resume, corrupt chunks/cleanup, queue snapshots, capacity/auth checks and mixed versions.

Benchmark (coder measured, 2 MiB localhost WebSocket relay, Ryzen 9 5950X/Go 1.26.1, six runs of 50 files): legacy 65–67 ms/file and 32–36 MiB sampled peak heap; streaming 11.5–11.7 ms/file and 3.5–4.0 MiB sampled peak heap. Sampling is every 200 microseconds and can miss short peaks; allocation totals are documented separately. See docs/feat/feat_20261113_agentlink_streamed_files.md for full protocol, compatibility and measurement details.

Not checked: real-network/multi-machine, Android, or separate-process mixed-version runs; old peers are simulated. No UI sources changed, so no visual/nsh checks required. No deployment, base push or tags. Initial code push failed because the credential helper required a repository path; a command-local credential.useHttpPath=true retry succeeded.

## factory · review · 2026-11-13 19:54
head: b5e4c417d0ea4636d185cb3af1ffb25faa6a779d
verdict: pass
notes:
- [P2] internal/agentlink/relay_stream.go:124: Receiver chunk acknowledgements are matched only by message ID, not delivery attempt. After sender reconnect, stale acknowledgements can start the new sender at an obsolete offset, causing invalid_message and deleting resumable parts. Verified with a slowed receiver (40 ms/chunk), 1 MiB transfer and immediate sender reattach: 5/5 failures, final chunk offset 524288 versus expected 327680. Real Console retries after at least 1 s, so reproducing there requires a sufficiently slow receiver/link. Bind delivery, chunks and acknowledgements to an attempt ID or gate stale acknowledgements until the new resume handshake.
- [P3] internal/agentlink/stream_recv.go:143: makeRoomLocked evicts paused transfers before authorizeFiles. Verified: an authorized paused four-file/256 MiB transfer with one chunk received loses all four part files when an unauthorized peer announces a 1-byte message, before that peer is rejected. Authorize before capacity eviction.
- [P3] tools/builtin/contacts_send_file.go:286: Reply attachment capture now retains only a checked source path until reply sending, unlike master's attach-time byte snapshot. Verified: attach report.csv with v1,1, overwrite with v2,22, then SendWithAttachments fails with file changed after it was checked and sendReply sends text without the file. Snapshot into private storage when attaching to the reply.

Validation: Claude Code reviewed origin/master...HEAD (merge base c8ca9dce), read repository instructions and the review-code security reference, and passed the required gofmt check, go vet ./..., and go test ./... with an absolute throwaway HOME, existing Go caches and Go 1.26.1. Three temporary reproduction probes were removed; manager verified the worktree clean and reviewed HEAD unchanged. No unpinned installations. No Console sources changed, so nsh/visual checks were not applicable. Under factory policy only P0/P1 block readiness; the P2/P3 findings above remain for owner attention before ship.

Residual risks: simultaneous sends sharing a message ID may collide in queue snapshots; queue expiry while relay chunks remain could temporarily exceed the relay window; neither reproduced. Real multi-machine networks, Android, separate-process mixed versions and receiver restart were not exercised. Receiver restart resume state is intentionally not durable. No linked issues or PRs were identified in the request thread.
