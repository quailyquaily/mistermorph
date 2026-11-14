package agentlink

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// Streamed file transfer. A message whose attachments carry a TransferID travels without their
// bytes: its JSON send/deliver frames hold the metadata only, and each file's bytes follow as
// binary WebSocket frames of at most streamChunkSize bytes, each tagged with the transfer ID, the
// delivery attempt and its offset. The receiver acknowledges every chunk it wrote (FrameChunkAck);
// its first acknowledgement of a transfer in an attempt is the offset it already holds, so a
// delivery after a reconnect continues from there.
//
// Every send of a streamed message is a new attempt with its own random ID, which its deliver,
// chunks, acknowledgements, aborts and results carry. A relay and a receiver act only on the frames
// of the attempt they currently carry: a chunk or an acknowledgement still in flight from an
// attempt that ended (a sender that reconnected, a lease that ran out) is dropped, so it can neither
// set where the next attempt starts nor fail it. A sender keeps at most streamWindow unacknowledged chunks per connection, and
// a relay drops a transfer whose sender passes the window. See
// docs/feat/feat_20261113_agentlink_streamed_files.md.
const (
	// CapabilityFilesStream is advertised by a runtime that takes streamed attachments, and kept in
	// the roster by a Console relay that carries them. A runtime advertises it only with
	// CapabilityFiles; a relay that predates it drops it from the roster, so a sender streams only
	// when its relay and the target both have it.
	CapabilityFilesStream = "files_stream"

	// MaxStreamAttachmentBytes is the largest file a streamed transfer carries.
	MaxStreamAttachmentBytes = int64(64 << 20)
	// MaxStreamMessageBytes is the most file bytes a message with streamed attachments carries.
	MaxStreamMessageBytes = MaxAttachments * MaxStreamAttachmentBytes

	// streamChunkSize is the most file bytes one binary frame carries. Every chunk but a file's last
	// is exactly this long.
	streamChunkSize = 64 << 10
	// streamWindow is how many chunks a sender may have unacknowledged on one connection.
	streamWindow = 4
	// streamIdleTimeout is how long a relay keeps a streamed delivery that makes no progress.
	streamIdleTimeout = 60 * time.Second
	// streamLeaseIdle is how long past the last acknowledgement a sender keeps the lease of a
	// streamed message; every acknowledgement renews it.
	streamLeaseIdle = 90 * time.Second

	// maxInboundStreams bounds the unfinished streamed deliveries a node keeps, connected or waiting
	// for a reconnect.
	maxInboundStreams = 4
	// maxInboundStreamBytes bounds the bytes those deliveries reserve in the inbox before they get
	// them.
	maxInboundStreamBytes = MaxStreamMessageBytes
	// maxInlineDispatchBytes bounds the file bytes a node reads into memory to send inline, to a
	// peer or through a relay that does not stream.
	maxInlineDispatchBytes = int64(16 << 20)

	// streamProgressStep is how many bytes pass between two progress lines in the log.
	streamProgressStep = int64(8 << 20)
)

// Binary frame layout (all integers big-endian):
//
//	offset  size  field
//	0       1     version, 1
//	1       1     kind, 1 = file data
//	2       16    transfer ID (the 32 hex characters of transfer_id, as bytes)
//	18      16    attempt ID (the 32 hex characters of the frames' attempt, as bytes)
//	34      8     offset of the data in the file
//	42      n     data, 1..streamChunkSize bytes
const (
	chunkVersion    = 1
	chunkKindData   = 1
	transferIDBytes = 16
	attemptIDBytes  = 16
	chunkOffsetAt   = 2 + transferIDBytes + attemptIDBytes
	chunkHeaderSize = chunkOffsetAt + 8
	maxChunkFrame   = chunkHeaderSize + streamChunkSize
)

// Chunk is a piece of a streamed file, carried by a binary frame.
type Chunk struct {
	TransferID string
	// Attempt is the delivery attempt the chunk belongs to.
	Attempt string
	Offset  int64
	Data    []byte
}

var errBadChunk = errors.New("malformed binary frame")

// encodeChunk returns the binary frame of c.
func encodeChunk(c *Chunk) ([]byte, error) {
	id, err := hex.DecodeString(c.TransferID)
	if err != nil || len(id) != transferIDBytes {
		return nil, fmt.Errorf("invalid transfer id %q", c.TransferID)
	}
	attempt, err := hex.DecodeString(c.Attempt)
	if err != nil || len(attempt) != attemptIDBytes {
		return nil, fmt.Errorf("invalid attempt id %q", c.Attempt)
	}
	if c.Offset < 0 || len(c.Data) == 0 || len(c.Data) > streamChunkSize {
		return nil, fmt.Errorf("invalid chunk (offset %d, %d bytes)", c.Offset, len(c.Data))
	}
	out := make([]byte, chunkHeaderSize+len(c.Data))
	out[0] = chunkVersion
	out[1] = chunkKindData
	copy(out[2:], id)
	copy(out[2+transferIDBytes:], attempt)
	binary.BigEndian.PutUint64(out[chunkOffsetAt:], uint64(c.Offset))
	copy(out[chunkHeaderSize:], c.Data)
	return out, nil
}

// decodeChunk parses a binary frame. The chunk's data is a slice of raw.
func decodeChunk(raw []byte) (*Chunk, error) {
	if len(raw) <= chunkHeaderSize || len(raw) > maxChunkFrame {
		return nil, fmt.Errorf("%w: %d bytes", errBadChunk, len(raw))
	}
	if raw[0] != chunkVersion || raw[1] != chunkKindData {
		return nil, fmt.Errorf("%w: version %d kind %d", errBadChunk, raw[0], raw[1])
	}
	offset := binary.BigEndian.Uint64(raw[chunkOffsetAt:])
	if offset > uint64(MaxStreamAttachmentBytes) {
		return nil, fmt.Errorf("%w: offset %d", errBadChunk, offset)
	}
	return &Chunk{
		TransferID: hex.EncodeToString(raw[2 : 2+transferIDBytes]),
		Attempt:    hex.EncodeToString(raw[2+transferIDBytes : chunkOffsetAt]),
		Offset:     int64(offset),
		Data:       raw[chunkHeaderSize:],
	}, nil
}

// newTransferID returns a random transfer ID.
func newTransferID() string { return randomHex(transferIDBytes) }

// newAttemptID returns a random delivery attempt ID.
func newAttemptID() string { return randomHex(attemptIDBytes) }

// validAttemptID reports whether id is 32 lowercase hex characters.
func validAttemptID(id string) bool { return validTransferID(id) }

// validTransferID reports whether id is 32 lowercase hex characters.
func validTransferID(id string) bool {
	if len(id) != 2*transferIDBytes {
		return false
	}
	for _, r := range id {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// validSHA256 reports whether digest is a SHA-256 in lowercase hex.
func validSHA256(digest string) bool {
	if len(digest) != 64 {
		return false
	}
	for _, r := range digest {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// streamed reports whether attachments travel as streamed transfers.
func streamed(attachments []Attachment) bool {
	return len(attachments) > 0 && attachments[0].TransferID != ""
}

// chunkLen is how long the chunk at offset of a file of size bytes must be.
func chunkLen(size, offset int64) int64 {
	return min(int64(streamChunkSize), size-offset)
}

// sameTransfers reports whether two messages announce the same streamed files.
func sameTransfers(a, b []Attachment) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].TransferID != b[i].TransferID || a[i].Filename != b[i].Filename || a[i].MediaType != b[i].MediaType ||
			a[i].Size != b[i].Size || a[i].SHA256 != b[i].SHA256 {
			return false
		}
	}
	return true
}

// TransferStatus is the progress of one streamed file, sent or received.
type TransferStatus struct {
	TransferID string `json:"transfer_id"`
	MessageID  string `json:"message_id"`
	// Peer is the instance ID of the other agent.
	Peer     string `json:"peer"`
	Filename string `json:"filename"`
	// Direction is "send" or "receive".
	Direction string `json:"direction"`
	Size      int64  `json:"size"`
	// Bytes is how many bytes the receiver acknowledged (send) or wrote (receive).
	Bytes int64 `json:"bytes"`
	// Connected is false while the transfer waits for a Console to resume it.
	Connected bool `json:"connected"`
}
