package agentlink

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	helloTimeout   = 10 * time.Second
	deliverTimeout = 20 * time.Second
	// attachmentDeliverExtra is the extra time a delivery with files gets to cross a slow link.
	attachmentDeliverExtra = 60 * time.Second
)

// errSendQueueFull ends a connection whose runtime reads frames slower than the relay sends them.
var errSendQueueFull = errors.New("send queue full")

// ErrDuplicateInstance is returned by Relay.Serve when a runtime with the same instance ID is
// already connected.
var ErrDuplicateInstance = errors.New("agentlink: instance id is already connected")

// Relay is a Console's end of Agent Link: it lists the connected runtimes to each other and carries
// messages between them.
type Relay struct {
	logger *slog.Logger

	mu      sync.Mutex
	members map[string]*relayMember
	pending map[string]*pendingDelivery
	// fileBytes is the inline attachment bytes of the pending deliveries, at most maxFileBytes.
	fileBytes    int64
	maxFileBytes int64
	// transfers finds the streamed delivery of a chunk by its sender and transfer ID.
	transfers map[string]*pendingDelivery
	// streamBytes is the streamed bytes forwarded and not yet acknowledged by their receivers;
	// peakStreamBytes the most it has been.
	streamBytes     int64
	peakStreamBytes int64
	// noStream makes the relay act as one from before streamed files: it keeps
	// CapabilityFilesStream out of the roster and refuses streamed messages. Tests use it to stand
	// in for an older Console.
	noStream bool
}

type relayMember struct {
	peer   Peer
	label  string
	ctx    context.Context
	cancel context.CancelCauseFunc
	out    chan Frame
	// chunks is how many chunks the member sent that its receivers have not acknowledged.
	chunks int
}

func (m *relayMember) send(frame Frame) bool {
	select {
	case <-m.ctx.Done():
		return false
	default:
	}
	select {
	case m.out <- frame:
		return true
	case <-m.ctx.Done():
		return false
	default:
		m.cancel(errSendQueueFull)
		return false
	}
}

type pendingDelivery struct {
	messageID string
	source    *relayMember
	target    *relayMember
	leaseID   string
	// attempt is the sender's attempt ID of a streamed delivery; only frames with it belong to
	// the delivery.
	attempt string
	timer   *time.Timer
	// fileBytes is the inline attachment bytes the delivery carries.
	fileBytes int64
	// stream is the state of a delivery with streamed files.
	stream *relayStream
}

// NewRelay returns an empty relay.
func NewRelay(logger *slog.Logger) *Relay {
	if logger == nil {
		logger = slog.Default()
	}
	return &Relay{
		logger:  logger.With("component", "agentlink_relay"),
		members: make(map[string]*relayMember),
		pending: make(map[string]*pendingDelivery),

		maxFileBytes: maxRelayAttachmentBytes,
		transfers:    make(map[string]*pendingDelivery),
	}
}

// Members returns the connected agents, sorted by instance ID.
func (r *Relay) Members() []Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rosterLocked()
}

func (r *Relay) rosterLocked() []Peer {
	out := make([]Peer, 0, len(r.members))
	for _, member := range r.members {
		out = append(out, member.peer)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstanceID < out[j].InstanceID })
	return out
}

func (r *Relay) broadcastRosterLocked() {
	roster := r.rosterLocked()
	for _, member := range r.members {
		member.send(Frame{Type: FrameRoster, Agents: roster})
	}
}

// Serve runs one runtime's connection until it closes or ctx ends. label names the endpoint in
// logs.
func (r *Relay) Serve(ctx context.Context, conn Conn, label string) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	helloCtx, helloCancel := context.WithTimeout(ctx, helloTimeout)
	hello, err := conn.ReadFrame(helloCtx)
	helloCancel()
	if err != nil {
		return fmt.Errorf("agent link hello: %w", err)
	}
	if hello.Type != FrameHello || !ValidInstanceID(hello.InstanceID) {
		_ = conn.WriteFrame(ctx, Frame{Type: FrameError, Reason: ReasonInvalid})
		return fmt.Errorf("agent link hello: invalid frame")
	}
	member := &relayMember{
		peer: Peer{
			InstanceID: strings.TrimSpace(hello.InstanceID), AgentName: strings.TrimSpace(hello.AgentName),
			Capabilities: r.capabilities(hello.Capabilities),
		},
		label:  label,
		ctx:    ctx,
		cancel: cancel,
		out:    make(chan Frame, 256),
	}

	r.mu.Lock()
	if existing := r.members[member.peer.InstanceID]; existing != nil {
		r.mu.Unlock()
		r.logger.Warn("agentlink_duplicate_instance", "instance_id", member.peer.InstanceID, "endpoint", label, "connected_endpoint", existing.label)
		_ = conn.WriteFrame(ctx, Frame{Type: FrameError, Reason: ReasonDuplicate})
		return fmt.Errorf("%w: %s (already connected through %s)", ErrDuplicateInstance, member.peer.InstanceID, existing.label)
	}
	r.members[member.peer.InstanceID] = member
	r.broadcastRosterLocked()
	r.mu.Unlock()
	r.logger.Info("agentlink_member_joined", "instance_id", member.peer.InstanceID, "agent_name", member.peer.AgentName, "endpoint", label)
	// Why the connection ended, for the log: the runtime closed it, the network dropped it, or it
	// went silent past idleTimeout. "closed" means this side ended it (ctx done).
	reason := "closed"
	defer func() { r.removeMember(member, reason) }()

	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-member.out:
				if err := conn.WriteFrame(ctx, frame); err != nil {
					cancel(fmt.Errorf("write: %w", err))
					return
				}
			case <-ticker.C:
				if err := conn.WriteFrame(ctx, Frame{Type: FramePing}); err != nil {
					cancel(fmt.Errorf("write ping: %w", err))
					return
				}
			}
		}
	}()

	for {
		frame, readErr := conn.ReadFrame(ctx)
		if readErr != nil {
			if ctx.Err() != nil {
				if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
					reason = cause.Error()
				}
				return nil
			}
			reason = readErr.Error()
			return readErr
		}
		switch frame.Type {
		case FrameSend:
			r.route(member, frame)
		case FrameDeliverResult:
			r.completeDelivery(member, frame)
		case FrameChunk:
			r.forwardChunk(member, frame)
		case FrameChunkAck:
			r.forwardAck(member, frame)
		case FramePing:
			member.send(Frame{Type: FramePong})
		case FramePong:
		case FrameHello:
			// The agent was renamed, or its capabilities changed; reconnecting is not needed to
			// update the roster.
			name := strings.TrimSpace(frame.AgentName)
			capabilities := r.capabilities(frame.Capabilities)
			r.mu.Lock()
			if member.peer.AgentName != name || !slices.Equal(member.peer.Capabilities, capabilities) {
				member.peer.AgentName = name
				member.peer.Capabilities = capabilities
				r.broadcastRosterLocked()
			}
			r.mu.Unlock()
		default:
			r.logger.Debug("agentlink_unknown_frame", "type", frame.Type, "endpoint", label)
		}
	}
}

func (r *Relay) removeMember(member *relayMember, reason string) {
	member.cancel(nil)
	var unreachable, gone []*pendingDelivery
	var unreachableIDs, goneIDs []string
	r.mu.Lock()
	if r.members[member.peer.InstanceID] == member {
		delete(r.members, member.peer.InstanceID)
		r.broadcastRosterLocked()
	}
	for id, p := range r.pending {
		switch {
		case p.target == member:
			unreachable = append(unreachable, p)
			unreachableIDs = append(unreachableIDs, id)
			r.dropPendingLocked(id, p)
		case p.source == member:
			if p.stream != nil {
				gone = append(gone, p)
				goneIDs = append(goneIDs, id)
			}
			r.dropPendingLocked(id, p)
		}
	}
	r.mu.Unlock()
	for i, p := range unreachable {
		p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: unreachableIDs[i], Status: StatusUnreachable})
	}
	for i, p := range gone {
		// The receiver keeps what it got, for when the sender delivers the message again.
		p.target.send(Frame{Type: FrameTransferAbort, MessageID: goneIDs[i], Attempt: p.attempt, Status: StatusUnreachable})
	}
	r.logger.Info("agentlink_member_left", "instance_id", member.peer.InstanceID, "endpoint", member.label, "reason", reason)
}

func (r *Relay) route(source *relayMember, frame Frame) {
	result := func(status, reason string) {
		source.send(Frame{Type: FrameSendResult, LeaseID: frame.LeaseID, MessageID: frame.MessageID, Status: status, Reason: reason})
	}
	if frame.Message == nil {
		result(StatusRejected, ReasonInvalid)
		return
	}
	msg := *frame.Message
	frame.MessageID = msg.MessageID
	// A runtime may only send as itself.
	msg.From = source.peer.InstanceID
	if err := msg.Validate(); err != nil {
		result(StatusRejected, ReasonInvalid)
		return
	}
	withStream := streamed(msg.Attachments)
	if withStream && (r.noStream || !validAttemptID(frame.Attempt)) {
		// What a Console from before streamed files answers; a streamed send names its attempt.
		result(StatusRejected, ReasonInvalid)
		return
	}
	if !withStream {
		frame.Attempt = ""
	}
	fileBytes := inlineBytes(msg.Attachments)
	timeout := deliverTimeout
	r.mu.Lock()
	target := r.members[msg.To]
	if target == nil {
		r.mu.Unlock()
		result(StatusUnreachable, "")
		return
	}
	if withStream {
		if !hasCapability(target.peer.Capabilities, CapabilityFilesStream) {
			r.mu.Unlock()
			r.logger.Info("agentlink_files_unsupported", "message_id", msg.MessageID, "from", msg.From, "to", msg.To, "streamed", true)
			result(StatusRejected, ReasonFilesUnsupported)
			return
		}
		for _, a := range msg.Attachments {
			if p := r.transfers[transferKey(source, a.TransferID)]; p != nil && r.pending[msg.MessageID] != p {
				// A transfer ID belongs to one message.
				r.mu.Unlock()
				result(StatusRejected, ReasonInvalid)
				return
			}
		}
		timeout = streamIdleTimeout
	} else if len(msg.Attachments) > 0 {
		if !hasCapability(target.peer.Capabilities, CapabilityFiles) {
			r.mu.Unlock()
			r.logger.Info("agentlink_files_unsupported", "message_id", msg.MessageID, "from", msg.From, "to", msg.To)
			result(StatusRejected, ReasonFilesUnsupported)
			return
		}
		held := r.fileBytes
		if previous := r.pending[msg.MessageID]; previous != nil {
			held -= previous.fileBytes
		}
		if held+fileBytes > r.maxFileBytes {
			// Too many files in flight; the sender retries later.
			r.mu.Unlock()
			result(StatusUnreachable, "")
			return
		}
		timeout += attachmentDeliverExtra
	}
	if previous := r.pending[msg.MessageID]; previous != nil {
		// The sender's lease ran out and it sent again through this Console; answer the new lease.
		r.dropPendingLocked(msg.MessageID, previous)
	}
	p := &pendingDelivery{messageID: msg.MessageID, source: source, target: target, leaseID: frame.LeaseID, attempt: frame.Attempt, fileBytes: fileBytes}
	p.timer = time.AfterFunc(timeout, func() { r.expireDelivery(msg.MessageID, p) })
	r.pending[msg.MessageID] = p
	r.fileBytes += fileBytes
	if withStream {
		p.stream = newRelayStream(msg.Attachments)
		for _, a := range msg.Attachments {
			r.transfers[transferKey(source, a.TransferID)] = p
		}
	}
	r.mu.Unlock()
	if !target.send(Frame{Type: FrameDeliver, MessageID: msg.MessageID, Attempt: p.attempt, Message: &msg}) {
		r.expireDelivery(msg.MessageID, p)
	}
}

// dropPendingLocked forgets a pending delivery and the file bytes it held.
func (r *Relay) dropPendingLocked(messageID string, p *pendingDelivery) {
	if r.pending[messageID] == p {
		delete(r.pending, messageID)
	}
	p.timer.Stop()
	r.fileBytes -= p.fileBytes
	p.fileBytes = 0
	r.releaseStreamLocked(p)
}

func (r *Relay) expireDelivery(messageID string, p *pendingDelivery) {
	r.mu.Lock()
	if r.pending[messageID] != p {
		r.mu.Unlock()
		return
	}
	r.dropPendingLocked(messageID, p)
	r.mu.Unlock()
	p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: messageID, Status: StatusUnreachable})
	if p.stream != nil {
		// No progress for streamIdleTimeout; the receiver keeps what it got for a resume.
		p.target.send(Frame{Type: FrameTransferAbort, MessageID: messageID, Attempt: p.attempt, Status: StatusUnreachable})
	}
}

func (r *Relay) completeDelivery(target *relayMember, frame Frame) {
	id := strings.TrimSpace(frame.MessageID)
	r.mu.Lock()
	p := r.pending[id]
	if p == nil || p.target != target || (p.stream != nil && frame.Attempt != p.attempt) {
		// No delivery, or the result of an earlier attempt of a streamed one.
		r.mu.Unlock()
		return
	}
	r.dropPendingLocked(id, p)
	r.mu.Unlock()
	status := frame.Status
	switch status {
	case StatusAccepted:
		status = StatusDelivered
	case StatusRejected:
	default:
		status = StatusUnreachable
	}
	p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: id, Status: status, Reason: frame.Reason})
}
