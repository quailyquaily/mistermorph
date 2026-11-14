---
date: 2026-11-13
title: "Agent Link: streamed file transfer"
status: implemented-v1
---

# Agent Link: streamed file transfer

Follow-up to `feat_20261111_agentlink_file_transfer.md` (the inline path, which stays as it is for
routes that do not stream).

## Why

In the inline path a file travels as base64 inside one JSON `message` frame. That costs about 33%
more bytes on the wire; a Console relay reads, decodes, checks and re-encodes the whole frame before
forwarding it, so two hops run one after the other; one frame of up to 2.7 MiB holds the runtime's
connection while other messages and pings wait; a drop resends everything; and every hop holds the
whole file in memory, which is why the limit is 2 MiB.

Streamed transfer sends the file's metadata in a small JSON frame and its bytes in binary WebSocket
frames of 64 KiB, which a relay forwards as they arrive.

## Negotiation

- A runtime that takes files announces `capabilities: ["files", "files_stream"]` in its `hello`.
- A Console relay of this version keeps `files_stream` in the `roster` entry of a runtime that
  announced it (only together with `files`). A relay from before this change keeps only `files`
  (FT95) or nothing, so its roster never lists `files_stream`.
- A runtime streams a message's files to a peer only through a Console whose roster lists the peer
  with `files_stream`. That one roster entry covers the relay and the target; the sending runtime
  streams because it is of this version.
- Otherwise it uses the inline path unchanged, which older runtimes and Consoles keep using, as long
  as the files fit its limit (2 MiB in all). Larger files:
  - fail the tool call when the peer is reachable now only through such a route
    (`agentlink.ErrFileTooLarge`, saying the route does not stream);
  - wait in the queue when the peer is not reachable now, and are rejected with
    `files_unsupported` if the peer then turns up only through such a route.
- An older runtime or Console never receives a binary frame: chunks go only to a relay that listed
  `files_stream` and, from it, only to a target that announced it. A relay of this version also
  refuses a streamed message for a target without `files_stream` (`files_unsupported`).

## Protocol

### Frames

| Frame | Direction | Content |
|---|---|---|
| `send` / `deliver` | sender → relay → receiver | The message, its `attachments` with `filename`, `media_type`, `size`, `sha256` and `transfer_id`, and no `data`; and the `attempt`. |
| `chunk_ack` | receiver → relay → sender | `message_id`, `attempt`, `transfer_id`, `offset`: the bytes of the file the receiver holds. The relay adds the sender's `lease_id`. |
| binary | sender → relay → receiver | One chunk of one file in one attempt (layout below). |
| `transfer_abort` | relay → receiver | `message_id`, `attempt`, `status`, `reason`: the relay dropped that attempt. `rejected`: the receiver removes its partial files; `unreachable`: it keeps them for a resume. |
| `deliver_result` / `send_result` | receiver → relay → sender | As before; the end of the delivery. A streamed delivery's `deliver_result` carries its `attempt`. |

`transfer_id` is 32 lowercase hex characters, random per file, chosen when the message is queued and
kept with it, so every delivery of the message (after a reconnect or a restart) uses the same IDs.
A message's files are all inline or all streamed.

`attempt` is 32 lowercase hex characters, random per delivery attempt: the sender picks a new one
each time it sends (leases) a streamed message, and every frame of that attempt carries it (the
`deliver`, each chunk, each `chunk_ack`, a `transfer_abort`, the `deliver_result`). A streamed `send`
or `deliver` without one is refused (`invalid_message`). The relay and the receiver act only on the
frames of the attempt they currently carry; a chunk, acknowledgement, abort or result of an earlier
attempt of the same message is dropped silently. This matters when the sender reconnects or its
lease runs out while frames of the attempt it gave up are still in flight: a slow receiver may still
be writing and acknowledging chunks the relay forwarded before. Without the attempt, such a stale
acknowledgement could be taken for the new attempt's starting offset, and the next chunk would then
be out of order and fail the transfer, removing the partial files the resume was meant to keep.

### Binary frame layout

All integers big-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | version, `1` |
| 1 | 1 | kind, `1` = file data |
| 2 | 16 | transfer ID (the 32 hex characters of `transfer_id` as bytes) |
| 18 | 16 | attempt ID (the 32 hex characters of `attempt` as bytes) |
| 34 | 8 | offset of the data in the file |
| 42 | 1..65536 | data |

Every chunk but a file's last is exactly 64 KiB, so a chunk's length follows from the file's size and
the offset. A binary frame that does not parse (short, too long, another version or kind) is logged
and dropped; it is never forwarded.

### Sequence

1. The sender sends `send` with the metadata. Nothing else goes until the receiver answers.
2. The relay checks the message (below) and forwards `deliver`.
3. The receiver checks it and authorizes the sender, then reserves room, creates one partial file
   per attachment and sends one `chunk_ack` per file, in the attempt, with the bytes it holds: 0
   for a new delivery, more for a resumed one. The relay takes the first acknowledgement of each
   file in the attempt as where that attempt starts.
4. The sender sends each file in order from that offset, at most 4 unacknowledged chunks per
   connection. The receiver writes each chunk and acknowledges it.
5. When every file is complete and verified, the receiver publishes the files, hands the message to
   the waiting `agent_send` or its task runner, and answers `deliver_result` as before.

A file of 0 bytes needs no chunk; a message of only empty files completes at step 3.

### Flow control and interleaving

- The window is 4 chunks (256 KiB) per connection, shared by every transfer the sender has on it,
  and released by the receiver's acknowledgements (end to end through the relay).
- Chunks and ordinary frames share the connection's write queue, so a message, an answer, a ping or
  a roster waits behind at most 4 chunks.
- A chunk is written with the fixed 10 s write deadline; the deadline no longer grows with a file's
  size. (An inline frame keeps its longer deadline.)
- A relay drops a streamed delivery without progress for 60 s (`unreachable` to the sender,
  `transfer_abort` with `unreachable` to the receiver). The sender's lease of a streamed message is
  renewed by each acknowledgement (90 s past the last one).

## Checks at each trust boundary

| Where | Checks |
|---|---|
| Sending tool | As before (recipient, allowed roots after resolving symlinks, regular file), with the limit of the route: 64 MiB per file when it streams or when the peer is not reachable now, 2 MiB otherwise. The error names the limit. |
| Sending runtime | The file is copied into the queue (`state_dir/agentlink/outbox-files/<message>/<n>`, 0600), checked as it is copied: regular file, size and SHA-256 as the tool saw them. Count, per-file, per-message, route and queue limits before that. |
| Console relay | The sender is the connected runtime (`from` is overwritten). The metadata is checked before anything is forwarded: count, sizes against the streamed limits, `transfer_id` format and uniqueness, `attempt` format, clean filename, normalized media type, SHA-256 format. The target must have announced `files_stream`. Chunks and acknowledgements of another attempt are dropped without a check. Then each chunk: the receiver acknowledged the transfer in the attempt, the offset is the next one, the length is the expected one (not short, not longer, not past the size), and the sender has at most 4 chunks unacknowledged. A failed check drops the delivery: `send_result` `rejected` `invalid_message` to the sender, `transfer_abort` `rejected` to the receiver. |
| Receiving runtime | The same metadata checks; addressed to it; a repeat is accepted without taking bytes; the sender authorized (as before; an answer to a message it sent is always taken); then, and only then, room reserved. All before the first acknowledgement. A delivery refused for any reason never drops another one: a sender that may not send files is refused before room is made, so it cannot make the receiver drop an authorized delivery waiting for a resume. Then each chunk as the relay checks it, the SHA-256 of each file when its last byte arrives. |

## Receiving

- Partial files are created `0600` as `.part-<random>` in `file_cache_dir/agentlink/<sender>/`,
  through the same `os.Root` and `0700` folder checks as before. Chunks are written as they arrive
  and hashed on the way; the bytes never sit in memory beyond one chunk.
- A file whose last chunk makes its SHA-256 differ, or a chunk out of order, too short, too long or
  past the declared size, rejects the message with `invalid_message`; a write error with
  `attachment_store_failed`. Either way the delivery's partial files are removed.
- When all files are complete, they are synced and published under their generated names (hard link,
  or rename after checking the name is free), as before. Only then does the message go to the task
  or the waiting `agent_send`; a rejection by the runner removes the files, as before.
- Room: a streamed delivery reserves its total size before its first byte. At most 4 unfinished
  streamed deliveries (connected or waiting for a resume) and 256 MiB reserved at once; the inbox
  cleanup keeps the reserved room free (it evicts the oldest received files, never a partial file of
  an unfinished delivery). Over that, the oldest deliveries waiting for a resume are dropped, but
  only for a delivery that passed every other check (authorization included), and only when
  dropping them makes enough room; otherwise none is dropped, the new one is answered `unreachable`
  and the sender retries.

## Resume

- When the connection carrying a delivery drops (or the relay drops it as `unreachable`), the
  receiver keeps the delivery and its partial files.
- When the sender delivers the message again (its lease ends, or the relay reports the target
  unreachable, and it retries through any Console), the receiver recognizes it by sender and message
  ID, checks that the files' metadata and transfer IDs are the same, moves the delivery to the new
  connection and attempt and acknowledges what it holds, in the new attempt. The sender continues
  from there. The offset comes from the receiver's own count of written bytes; a different file list
  for the same message is refused (`invalid_message`).
- Chunks still arriving on the old connection, or in the old attempt on the same connection, are
  ignored, as is a `transfer_abort` of the old attempt; the relay drops the receiver's
  acknowledgements of the old attempt, so only the new attempt's acknowledgement sets where it
  starts. A sender may reconnect at once while a slow receiver still works through the old
  attempt's chunks.
- Lifetime: an unfinished delivery lives in the receiving runtime's memory. It is dropped (and its
  partial files removed) after 1 hour without progress, when its room is needed for another one, or
  when the runtime stops. After a restart of the receiver the transfer starts again from 0, and the
  partial files left behind go with the existing cleanup of `.part-*` files older than 1 hour. A
  restart of the sender or of the Console resumes: the queue keeps the transfer IDs and the file
  copies on disk.
- A message received before is answered `accepted` at once, so a retry after a lost confirmation
  saves nothing twice.

## Limits

Fixed constants; no config keys.

| Limit | Inline (unchanged) | Streamed |
|---|---|---|
| File bytes per file | 2 MiB | 64 MiB (`agentlink.MaxStreamAttachmentBytes`) |
| File bytes per message | 2 MiB | 256 MiB (4 × 64 MiB, `agentlink.MaxStreamMessageBytes`) |
| Files per message | 4 | 4 |
| Chunk | — | 64 KiB |
| Unacknowledged chunks per connection | — | 4 |
| Relay memory | 32 MiB of inline files in flight | the chunks forwarded and not acknowledged: at most 4 per sending connection |
| Sender memory | the message (base64) while it is sent | the chunks in the window; queued files stay on disk |
| Inline sends read back from the queue at once | 16 MiB | — |

Changed for both paths, since queued and received files are on disk:

| Limit | Before | Now |
|---|---|---|
| File bytes waiting in a runtime's queue | 16 MiB (memory and disk) | 512 MiB on disk (two full streamed messages) |
| Received files kept | 7 days, 256 files, 64 MiB | 7 days, 256 files, 512 MiB |
| Unfinished streamed deliveries | — | 4, 256 MiB reserved |

`queue_ttl` still applies to a queued message whatever its route.

## Progress

The runtime logs each transfer's bytes:

- `agentlink_transfer_started` (direction `send` with the starting offset, `receive` with the files
  and total size), `agentlink_transfer_resumed` (receive, with the offset held);
- `agentlink_transfer_progress` every 8 MiB and at the end of each file (`bytes`, `size`);
- `agentlink_transfer_finished`, `agentlink_transfer_rejected`, `agentlink_transfer_abandoned`, and
  on a relay `agentlink_transfer_aborted` with the reason.

`Node.Transfers()` returns the same per file (sent or received bytes, size, whether a connection
carries it) for a future Console view; there is no UI for it yet.

## Unchanged

Files in answers (`ReplyFiles`, `attached_to_reply`), the task note with saved paths,
untrusted-file handling, `unauthorized` / `files_unsupported` semantics, `queue_ttl` expiry, and the
tool interface of `agent_send` and `contacts_send`, except the larger limit on streamed routes. A
file attached to an answer is still taken as it is when it is attached: its bytes are copied then
(checked against the size and SHA-256 the tool saw, after the allowed-roots and regular-file checks)
into a private folder of the answer (`state_dir/agentlink/reply-files/reply-<random>/<n>`, `0700`
and `0600`), not held in memory as before; later changes to the source, or its removal, do not
change what the answer carries. The answer is queued from that copy (the queue makes its own), and
the folder is removed once the answer is queued or the task ends without one; a folder a process
left behind is removed when the node opens again.

## Benchmark

`BenchmarkRelayFileTransfer2MiB` in `internal/agentlink/stream_bench_test.go` sends a 2 MiB file
from one runtime to another through a relay, every hop a real WebSocket on localhost, all three in
one process:

- `old`: runtimes and relay as before this change (bytes in the queue entry, base64 in one frame);
- `inline`: runtimes of this version through a relay that does not stream (file queued on disk,
  read back, sent as `old`);
- `stream`: binary chunks.

Measured 2026-11-13 on an AMD Ryzen 9 5950X (16 cores, 32 threads), Linux amd64, Go 1.26.1, local
disk, with
`go test ./internal/agentlink/ -run '^$' -bench BenchmarkRelayFileTransfer2MiB -benchmem -benchtime=50x -count=6`
(range of the 6 runs, 50 files each):

| Path | Time per file | Peak heap (sampled) | Allocated per file | Allocations per file |
|---|---|---|---|---|
| old | 65.1–66.9 ms | 31.7–35.7 MiB | 51.4–52.5 MB | ~983 |
| inline | 48.5–50.8 ms | 27.8–34.1 MiB | 34.8–35.9 MB | ~990 |
| stream | 11.5–11.7 ms | 3.5–4.0 MiB | 16.6 MB | ~3950 |

How to read it:

- Time is wall time per file, from the send to the sender's `delivered`, including the queue copy
  and the receiver's sync.
- Peak heap is the highest heap in use (live objects and garbage not yet collected) above the
  level before the first send, sampled every 200 µs with `runtime/metrics`; a shorter peak can be
  missed. It is the memory of sender, relay and receiver together.
- Allocated per file (`B/op`) counts every allocation, freed or not; it is not memory held at once.
  Streaming allocates a fresh buffer per chunk at each hop (more, smaller allocations) but holds a
  few chunks at a time, which is what the peak shows.
- Localhost has almost no latency. Over a real network the window (256 KiB per connection) bounds
  throughput to about 256 KiB per round trip, for example 5 MiB/s at 50 ms; the inline path is
  bounded instead by the time each hop takes to receive and resend the whole frame.

## Tests

- `internal/agentlink/stream_test.go`: in process and over real WebSockets, binary, empty, exactly
  one chunk, one byte over, over the inline limit and the largest (64 MiB) files; four files in one
  message; text frames both ways while a slow transfer is under way; the relay's peak of buffered
  stream bytes against its window; resume after the receiver's connection drops and after the sender
  restarts, each byte written once and no duplicate file; a repeated delivery saving nothing;
  out-of-order, oversized, short, past-the-size and corrupt chunks, by the receiver and by the relay
  (partial files removed, both ends told); a sender past its window; malformed binary frames;
  fallback for a new runtime to an old one, an old runtime to a new one, new runtimes through an
  old Console (no binary frame reaches an old peer), a queued large file finding only a route that
  does not stream; the queue's own copy against a changed source; sends of one message ID at once
  queued once with their copies intact; limits; the inbound delivery and
  reservation bounds; checks before any byte (unauthorized, no handler, handler rejection); a queue
  entry written by an older version.
- `internal/agentlink/stream_regression_test.go`: a sender that reconnects at once while a slow
  receiver (40 ms per chunk) works through the chunks of the attempt it gave up, in process and
  over real WebSockets, resuming with each byte written once; the relay and the receiver dropping
  chunks, acknowledgements, aborts and results of an earlier attempt; streamed frames without an
  attempt refused; an unauthorized sender (and a delivery there is no room for) never dropping a
  delivery that waits for a resume; answers' file copies against a changed or removed source, and
  their removal.
- `internal/agentlink/attachments_test.go`: the inline path as before, with the inline relay bound
  through a peer that does not stream.
- `tools/builtin/agent_send_files_test.go`, `contacts_send_file_test.go`: a file over the inline
  limit streamed end to end through the tools, the inline limit on a route that does not stream,
  the chat channels' 20 MiB limit, files attached to an answer, sent as attached after their source
  is overwritten or removed.

Not covered by automated tests: Agent Link between separate machines over a real network (latency,
real disconnects), Consoles of mixed versions as separate processes (simulated in process by a relay
and runtimes that act as older ones), and Android.

## Implementation notes

- `internal/agentlink/stream.go`: constants, binary layout, transfer and attempt IDs.
- `internal/agentlink/stream_send.go`: route limits (`FileLimit`), the queue's file copies, the
  sending stream and its window.
- `internal/agentlink/stream_recv.go`: the receiving side: checks, reservation, partial files,
  resume, completion.
- `internal/agentlink/relay_stream.go`: the relay's chunk and acknowledgement forwarding.
- `internal/agentlink/conn.go`: binary frames on the WebSocket; the in-process pipe carries chunks as
  they are.
- `internal/agentlink/attachments.go`: `OpenAttachmentFile` (a file named by its path, hashed without
  holding it), streamed metadata validation.
- `tools/builtin/contacts_send_file.go`, `internal/contactsruntime/agentlink.go`: route limits,
  files named by path.
