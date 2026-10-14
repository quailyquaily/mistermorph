package agentlink

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	helloTimeout   = 10 * time.Second
	deliverTimeout = 20 * time.Second
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
}

type relayMember struct {
	peer   Peer
	label  string
	ctx    context.Context
	cancel context.CancelCauseFunc
	out    chan Frame
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
	source  *relayMember
	target  *relayMember
	leaseID string
	timer   *time.Timer
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
		peer:   Peer{InstanceID: strings.TrimSpace(hello.InstanceID), AgentName: strings.TrimSpace(hello.AgentName)},
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
		case FramePing:
			member.send(Frame{Type: FramePong})
		case FramePong:
		case FrameHello:
			// The agent was renamed; reconnecting is not needed to update the roster.
			name := strings.TrimSpace(frame.AgentName)
			r.mu.Lock()
			if member.peer.AgentName != name {
				member.peer.AgentName = name
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
	var unreachable []*pendingDelivery
	var unreachableIDs []string
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
			delete(r.pending, id)
			p.timer.Stop()
		case p.source == member:
			delete(r.pending, id)
			p.timer.Stop()
		}
	}
	r.mu.Unlock()
	for i, p := range unreachable {
		p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: unreachableIDs[i], Status: StatusUnreachable})
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
	r.mu.Lock()
	target := r.members[msg.To]
	if target == nil {
		r.mu.Unlock()
		result(StatusUnreachable, "")
		return
	}
	if previous := r.pending[msg.MessageID]; previous != nil {
		// The sender's lease ran out and it sent again through this Console; answer the new lease.
		previous.timer.Stop()
	}
	p := &pendingDelivery{source: source, target: target, leaseID: frame.LeaseID}
	p.timer = time.AfterFunc(deliverTimeout, func() { r.expireDelivery(msg.MessageID, p) })
	r.pending[msg.MessageID] = p
	r.mu.Unlock()
	if !target.send(Frame{Type: FrameDeliver, MessageID: msg.MessageID, Message: &msg}) {
		r.expireDelivery(msg.MessageID, p)
	}
}

func (r *Relay) expireDelivery(messageID string, p *pendingDelivery) {
	r.mu.Lock()
	if r.pending[messageID] != p {
		r.mu.Unlock()
		return
	}
	delete(r.pending, messageID)
	r.mu.Unlock()
	p.timer.Stop()
	p.source.send(Frame{Type: FrameSendResult, LeaseID: p.leaseID, MessageID: messageID, Status: StatusUnreachable})
}

func (r *Relay) completeDelivery(target *relayMember, frame Frame) {
	id := strings.TrimSpace(frame.MessageID)
	r.mu.Lock()
	p := r.pending[id]
	if p == nil || p.target != target {
		r.mu.Unlock()
		return
	}
	delete(r.pending, id)
	r.mu.Unlock()
	p.timer.Stop()
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
