package agentlink

import "fmt"

// A relay streams files without assembling them: it checks the message's metadata before
// forwarding it (route), then forwards each chunk to the target as it arrives, checking that it is
// the next one of its file, of the right length and within the sender's window, and forwards the
// target's acknowledgements back with the sender's lease ID. It holds only the chunks forwarded and
// not yet acknowledged: at most streamWindow per sending connection.

type relayStream struct {
	transfers map[string]*relayTransfer
}

type relayTransfer struct {
	size int64
	// started is set by the receiver's first acknowledgement, which says where the transfer
	// starts; next is the offset of the next chunk, acked the bytes the receiver holds.
	started     bool
	next, acked int64
	// ends are the end offsets of the chunks forwarded and not yet acknowledged.
	ends []int64
}

func newRelayStream(attachments []Attachment) *relayStream {
	s := &relayStream{transfers: make(map[string]*relayTransfer, len(attachments))}
	for _, a := range attachments {
		s.transfers[a.TransferID] = &relayTransfer{size: a.Size}
	}
	return s
}

func transferKey(source *relayMember, transferID string) string {
	return source.peer.InstanceID + "/" + transferID
}

// capabilities keeps the capabilities this relay knows and carries.
func (r *Relay) capabilities(capabilities []string) []string {
	known := knownCapabilities(capabilities)
	if r.noStream && len(known) > 0 {
		return []string{CapabilityFiles}
	}
	return known
}

// releaseStreamLocked forgets a delivery's transfers and the chunks it held.
func (r *Relay) releaseStreamLocked(p *pendingDelivery) {
	if p.stream == nil {
		return
	}
	for id, t := range p.stream.transfers {
		if r.transfers[transferKey(p.source, id)] == p {
			delete(r.transfers, transferKey(p.source, id))
		}
		r.dropChunksLocked(p, t, t.next)
	}
}

// dropChunksLocked forgets the chunks of t that end at or before offset.
func (r *Relay) dropChunksLocked(p *pendingDelivery, t *relayTransfer, offset int64) {
	held := t.acked
	for len(t.ends) > 0 && t.ends[0] <= offset {
		end := t.ends[0]
		t.ends = t.ends[1:]
		r.streamBytes -= end - held
		held = end
		p.source.chunks--
	}
	t.acked = max(t.acked, held)
}

// forwardChunk passes a chunk from its sender to the delivery's target.
func (r *Relay) forwardChunk(source *relayMember, frame Frame) {
	chunk := frame.Chunk
	if chunk == nil {
		r.logger.Warn("agentlink_bad_binary_frame", "endpoint", source.label, "reason", frame.Reason)
		return
	}
	r.mu.Lock()
	p := r.transfers[transferKey(source, chunk.TransferID)]
	if p == nil {
		// The delivery ended; a late chunk is dropped.
		r.mu.Unlock()
		r.logger.Debug("agentlink_stale_chunk", "endpoint", source.label, "transfer_id", chunk.TransferID)
		return
	}
	id := p.messageID
	t := p.stream.transfers[chunk.TransferID]
	var problem string
	switch {
	case !t.started:
		problem = "chunk before the receiver was ready"
	case chunk.Offset != t.next:
		problem = fmt.Sprintf("chunk out of order (offset %d, expected %d)", chunk.Offset, t.next)
	case t.next >= t.size:
		problem = fmt.Sprintf("chunk past the declared size %d", t.size)
	case int64(len(chunk.Data)) != chunkLen(t.size, t.next):
		problem = fmt.Sprintf("chunk of %d bytes, expected %d", len(chunk.Data), chunkLen(t.size, t.next))
	case source.chunks >= streamWindow:
		problem = fmt.Sprintf("more than %d chunks unacknowledged", streamWindow)
	}
	if problem != "" {
		r.dropPendingLocked(id, p)
		r.mu.Unlock()
		r.abortStream(id, p, problem)
		return
	}
	t.next += int64(len(chunk.Data))
	t.ends = append(t.ends, t.next)
	source.chunks++
	r.streamBytes += int64(len(chunk.Data))
	r.peakStreamBytes = max(r.peakStreamBytes, r.streamBytes)
	p.timer.Reset(streamIdleTimeout)
	target := p.target
	r.mu.Unlock()
	if !target.send(frame) {
		r.expireDelivery(id, p)
	}
}

// forwardAck passes the target's acknowledgement to the sender.
func (r *Relay) forwardAck(target *relayMember, frame Frame) {
	r.mu.Lock()
	p := r.pending[frame.MessageID]
	if p == nil || p.target != target || p.stream == nil {
		r.mu.Unlock()
		return
	}
	t := p.stream.transfers[frame.TransferID]
	if t == nil {
		r.mu.Unlock()
		return
	}
	offset := frame.Offset
	var problem string
	switch {
	case !t.started && (offset < 0 || offset > t.size):
		problem = fmt.Sprintf("receiver starts at %d of %d bytes", offset, t.size)
	case !t.started:
		t.started = true
		t.next, t.acked = offset, offset
	case offset < t.acked || offset > t.next:
		problem = fmt.Sprintf("receiver acknowledged %d, between %d and %d expected", offset, t.acked, t.next)
	default:
		r.dropChunksLocked(p, t, offset)
		t.acked = offset
	}
	if problem != "" {
		r.dropPendingLocked(frame.MessageID, p)
		r.mu.Unlock()
		r.abortStream(frame.MessageID, p, problem)
		return
	}
	p.timer.Reset(streamIdleTimeout)
	r.mu.Unlock()
	p.source.send(Frame{Type: FrameChunkAck, LeaseID: p.leaseID, MessageID: frame.MessageID, TransferID: frame.TransferID, Offset: offset})
}

// abortStream tells both ends that the relay dropped a delivery for a protocol error: the sender's
// message is rejected as invalid and the receiver removes its partial files.
func (r *Relay) abortStream(messageID string, p *pendingDelivery, problem string) {
	r.logger.Warn("agentlink_transfer_aborted", "message_id", messageID, "from", p.source.peer.InstanceID, "to", p.target.peer.InstanceID, "reason", problem)
	p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: messageID, Status: StatusRejected, Reason: ReasonInvalid})
	p.target.send(Frame{Type: FrameTransferAbort, MessageID: messageID, Status: StatusRejected, Reason: ReasonInvalid})
}

// StreamBytes is the streamed bytes the relay forwarded and their receivers did not acknowledge
// yet: what it holds of streamed files.
func (r *Relay) StreamBytes() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.streamBytes
}
