package agentlink

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	defaultLeaseTimeout = 30 * time.Second
	defaultQueueTTL     = 24 * time.Hour
	dispatchInterval    = time.Second
	handlerTimeout      = 15 * time.Second
	maxRetryBackoff     = time.Minute
	seenRetention       = 7 * 24 * time.Hour
	maxSeenEntries      = 10000
)

// Options configure a Node.
type Options struct {
	// StateDir is the runtime's state dir: it holds the instance ID and the queue.
	StateDir string
	Logger   *slog.Logger
	// AgentName returns the agent's display name.
	AgentName func() string
	// LeaseTimeout is how long one Console holds a message before another may deliver it.
	LeaseTimeout time.Duration
	// QueueTTL is how long a message may wait for delivery.
	QueueTTL time.Duration
	Now      func() time.Time
}

// Handler accepts a message delivered to this runtime. It returns once the message is saved or
// queued for processing. A *RejectError rejects it with that reason; another error rejects it with
// ReasonHandlerErr.
type Handler func(ctx context.Context, msg Message) error

// RejectError rejects an incoming message; the sender sees Reason.
type RejectError struct {
	Reason string
	Err    error
}

func (e *RejectError) Error() string {
	if e.Err != nil {
		return e.Reason + ": " + e.Err.Error()
	}
	return e.Reason
}

func (e *RejectError) Unwrap() error { return e.Err }

// SendResult is how a send ended, or that it is still queued.
type SendResult struct {
	MessageID string `json:"message_id"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
}

// Node is a runtime's end of Agent Link. Every Console connected to the runtime serves through
// Serve; Send queues a message until one of them delivers it.
type Node struct {
	id     string
	dir    string
	opts   Options
	logger *slog.Logger

	mu       sync.Mutex
	conns    map[*nodeConn]struct{}
	outbox   map[string]*outboxEntry
	waiters  map[string][]chan SendResult
	handler  *handlerSlot
	seen     map[string]time.Time
	inflight map[string]bool
	// replies are the sends whose reply someone is waiting for, by message ID.
	replies map[string]*replyWaiter
	// asks are the sends that may still get a reply, by message ID; see ExpectReply.
	asks     map[string]askRecord
	sessions map[string]string
	connSeq  uint64
	// retryBase is the first retry delay; it doubles with each attempt.
	retryBase time.Duration

	notifyMu    sync.Mutex
	listeners   map[int]func([]Peer)
	nextListen  int
	lastPeers   []Peer
	kick        chan struct{}
	stop        context.CancelFunc
	dispatchers sync.WaitGroup
}

type handlerSlot struct{ handle Handler }

type nodeConn struct {
	seq    uint64
	conn   Conn
	ctx    context.Context
	cancel context.CancelFunc
	out    chan Frame
	roster map[string]Peer
	// name is the agent name last sent to this Console.
	name string
}

func (c *nodeConn) send(frame Frame) bool {
	select {
	case <-c.ctx.Done():
		return false
	default:
	}
	select {
	case c.out <- frame:
		return true
	case <-c.ctx.Done():
		return false
	default:
		// The Console stopped reading; drop the connection rather than block the node.
		c.cancel()
		return false
	}
}

type outboxEntry struct {
	Message   Message   `json:"message"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`

	lease      *nodeConn
	leaseID    string
	leaseUntil time.Time
	attempts   int
	notBefore  time.Time
}

// NewNode opens the node for opts.StateDir, loading its instance ID and any queued messages.
func NewNode(opts Options) (*Node, error) {
	id, err := LoadOrCreateInstanceID(opts.StateDir)
	if err != nil {
		return nil, err
	}
	if opts.LeaseTimeout <= 0 {
		opts.LeaseTimeout = defaultLeaseTimeout
	}
	if opts.QueueTTL <= 0 {
		opts.QueueTTL = defaultQueueTTL
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	n := &Node{
		id:        id,
		dir:       filepath.Join(filepath.Clean(strings.TrimSpace(opts.StateDir)), "agentlink"),
		opts:      opts,
		logger:    logger.With("component", "agentlink"),
		conns:     make(map[*nodeConn]struct{}),
		outbox:    make(map[string]*outboxEntry),
		waiters:   make(map[string][]chan SendResult),
		seen:      make(map[string]time.Time),
		inflight:  make(map[string]bool),
		replies:   make(map[string]*replyWaiter),
		asks:      make(map[string]askRecord),
		sessions:  make(map[string]string),
		listeners: make(map[int]func([]Peer)),
		kick:      make(chan struct{}, 1),
		retryBase: time.Second,
	}
	if err := n.loadOutbox(); err != nil {
		return nil, err
	}
	if err := n.loadSeen(); err != nil {
		return nil, err
	}
	n.loadAsks()
	ctx, cancel := context.WithCancel(context.Background())
	n.stop = cancel
	n.dispatchers.Add(1)
	go n.dispatchLoop(ctx)
	return n, nil
}

// InstanceID is this runtime's instance ID.
func (n *Node) InstanceID() string { return n.id }

// Close stops delivery. Queued messages stay on disk.
func (n *Node) Close() {
	if n == nil || n.stop == nil {
		return
	}
	n.stop()
	n.dispatchers.Wait()
	n.mu.Lock()
	for c := range n.conns {
		c.cancel()
	}
	n.mu.Unlock()
}

func (n *Node) agentName() string {
	if n.opts.AgentName == nil {
		return ""
	}
	return strings.TrimSpace(n.opts.AgentName())
}

// SetHandler makes h receive delivered messages until the returned function is called. Without a
// handler, deliveries are rejected.
func (n *Node) SetHandler(h Handler) (restore func()) {
	slot := &handlerSlot{handle: h}
	n.mu.Lock()
	previous := n.handler
	n.handler = slot
	n.mu.Unlock()
	return func() {
		n.mu.Lock()
		if n.handler == slot {
			n.handler = previous
		}
		n.mu.Unlock()
	}
}

// Peers returns every agent a connected Console reaches, sorted by instance ID.
func (n *Node) Peers() []Peer {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.peersLocked()
}

// Reachable reports whether a connected Console reaches instanceID.
func (n *Node) Reachable(instanceID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for c := range n.conns {
		if _, ok := c.roster[instanceID]; ok {
			return true
		}
	}
	return false
}

func (n *Node) peersLocked() []Peer {
	merged := make(map[string]Peer)
	for c := range n.conns {
		for id, peer := range c.roster {
			if existing, ok := merged[id]; ok && existing.AgentName != "" {
				continue
			}
			merged[id] = peer
		}
	}
	out := make([]Peer, 0, len(merged))
	for _, peer := range merged {
		out = append(out, peer)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstanceID < out[j].InstanceID })
	return out
}

// Subscribe calls fn with the reachable agents now and whenever they change, until the returned
// function is called. Calls are serialized.
func (n *Node) Subscribe(fn func([]Peer)) (cancel func()) {
	n.notifyMu.Lock()
	id := n.nextListen
	n.nextListen++
	n.listeners[id] = fn
	n.notifyMu.Unlock()
	fn(n.Peers())
	return func() {
		n.notifyMu.Lock()
		delete(n.listeners, id)
		n.notifyMu.Unlock()
	}
}

func (n *Node) notifyPeers() {
	n.notifyMu.Lock()
	defer n.notifyMu.Unlock()
	peers := n.Peers()
	if reflect.DeepEqual(peers, n.lastPeers) {
		return
	}
	n.lastPeers = peers
	for _, fn := range n.listeners {
		fn(append([]Peer(nil), peers...))
	}
}

// Send queues a message to the agent with instance ID to and waits up to wait for it to be
// delivered. A message not delivered by then stays queued, and the result says so.
func (n *Node) Send(ctx context.Context, to string, envelope busruntime.MessageEnvelope, hop int, wait time.Duration) (SendResult, error) {
	to = strings.TrimSpace(to)
	if to == n.id {
		return SendResult{}, fmt.Errorf("agent link cannot send to itself")
	}
	if hop < 1 {
		hop = 1
	}
	envelope.MessageID = strings.TrimSpace(envelope.MessageID)
	if envelope.MessageID == "" {
		envelope.MessageID = "msg_" + uuid.NewString()
	}
	if strings.TrimSpace(envelope.SentAt) == "" {
		envelope.SentAt = n.opts.Now().UTC().Format(time.RFC3339)
	}
	msg := Message{MessageID: envelope.MessageID, From: n.id, To: to, Hop: hop, Envelope: envelope}
	if err := msg.Validate(); err != nil {
		return SendResult{}, err
	}
	now := n.opts.Now().UTC()
	entry := &outboxEntry{Message: msg, CreatedAt: now, ExpiresAt: now.Add(n.opts.QueueTTL)}

	n.mu.Lock()
	if _, exists := n.outbox[msg.MessageID]; exists {
		n.mu.Unlock()
		return SendResult{MessageID: msg.MessageID, Status: StatusQueued}, nil
	}
	if err := n.writeEntry(entry); err != nil {
		n.mu.Unlock()
		return SendResult{}, err
	}
	n.outbox[msg.MessageID] = entry
	result := make(chan SendResult, 1)
	n.waiters[msg.MessageID] = append(n.waiters[msg.MessageID], result)
	n.mu.Unlock()
	n.wake()

	queued := SendResult{MessageID: msg.MessageID, Status: StatusQueued}
	if wait <= 0 {
		n.dropWaiter(msg.MessageID, result)
		return queued, nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case res := <-result:
		return res, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	n.dropWaiter(msg.MessageID, result)
	select {
	case res := <-result:
		return res, nil
	default:
		return queued, nil
	}
}

func (n *Node) dropWaiter(messageID string, result chan SendResult) {
	n.mu.Lock()
	defer n.mu.Unlock()
	list := n.waiters[messageID]
	for i, item := range list {
		if item == result {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(n.waiters, messageID)
	} else {
		n.waiters[messageID] = list
	}
}

func (n *Node) wake() {
	select {
	case n.kick <- struct{}{}:
	default:
	}
}

// Serve runs one Console's connection until it closes or ctx ends.
func (n *Node) Serve(ctx context.Context, conn Conn) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := &nodeConn{conn: conn, ctx: ctx, cancel: cancel, out: make(chan Frame, 256), roster: map[string]Peer{}}
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-c.out:
				if err := conn.WriteFrame(ctx, frame); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	c.name = n.agentName()
	c.send(Frame{Type: FrameHello, InstanceID: n.id, AgentName: c.name})
	n.mu.Lock()
	n.connSeq++
	c.seq = n.connSeq
	n.conns[c] = struct{}{}
	n.mu.Unlock()
	defer n.removeConn(c)

	for {
		frame, err := conn.ReadFrame(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		switch frame.Type {
		case FrameRoster:
			n.setRoster(c, frame.Agents)
		case FrameSendResult:
			n.handleSendResult(c, frame)
		case FrameDeliver:
			go n.handleDeliver(c, frame)
		case FramePing:
			c.send(Frame{Type: FramePong})
			// Tell the Console about a rename without reconnecting.
			if name := n.agentName(); name != c.name {
				c.name = name
				c.send(Frame{Type: FrameHello, InstanceID: n.id, AgentName: name})
			}
		case FramePong:
		case FrameError:
			return fmt.Errorf("agent link console error: %s", strings.TrimSpace(frame.Reason))
		default:
			n.logger.Debug("agentlink_unknown_frame", "type", frame.Type)
		}
	}
}

func (n *Node) removeConn(c *nodeConn) {
	c.cancel()
	n.mu.Lock()
	delete(n.conns, c)
	for _, entry := range n.outbox {
		if entry.lease == c {
			entry.lease = nil
			entry.leaseID = ""
		}
	}
	n.mu.Unlock()
	n.notifyPeers()
	n.wake()
}

func (n *Node) setRoster(c *nodeConn, agents []Peer) {
	roster := make(map[string]Peer, len(agents))
	for _, peer := range agents {
		peer.InstanceID = strings.TrimSpace(peer.InstanceID)
		peer.AgentName = strings.TrimSpace(peer.AgentName)
		if peer.InstanceID == n.id || !ValidInstanceID(peer.InstanceID) {
			continue
		}
		roster[peer.InstanceID] = peer
	}
	n.mu.Lock()
	if _, ok := n.conns[c]; ok {
		c.roster = roster
	}
	n.mu.Unlock()
	n.notifyPeers()
	n.wake()
}

func (n *Node) handleSendResult(c *nodeConn, frame Frame) {
	id := strings.TrimSpace(frame.MessageID)
	n.mu.Lock()
	entry := n.outbox[id]
	if entry == nil || entry.lease != c || entry.leaseID != frame.LeaseID {
		n.mu.Unlock()
		return
	}
	switch frame.Status {
	case StatusDelivered, StatusRejected:
		n.mu.Unlock()
		n.finish(id, SendResult{MessageID: id, Status: frame.Status, Reason: strings.TrimSpace(frame.Reason)})
		return
	default:
		entry.lease = nil
		entry.leaseID = ""
		n.backoffLocked(entry)
		n.mu.Unlock()
		n.wake()
	}
}

func (n *Node) backoffLocked(entry *outboxEntry) {
	entry.attempts++
	delay := n.retryBase << min(entry.attempts, 6)
	if delay > maxRetryBackoff {
		delay = maxRetryBackoff
	}
	entry.notBefore = n.opts.Now().Add(delay)
}

func (n *Node) finish(id string, result SendResult) {
	n.mu.Lock()
	entry := n.outbox[id]
	delete(n.outbox, id)
	waiters := n.waiters[id]
	delete(n.waiters, id)
	n.mu.Unlock()
	if entry == nil {
		return
	}
	if err := os.Remove(n.entryPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		n.logger.Warn("agentlink_outbox_remove_error", "message_id", id, "error", err.Error())
	}
	level := slog.LevelInfo
	if result.Status != StatusDelivered {
		level = slog.LevelWarn
	}
	n.logger.Log(context.Background(), level, "agentlink_send_finished", "message_id", id, "to", entry.Message.To, "status", result.Status, "reason", result.Reason)
	for _, waiter := range waiters {
		waiter <- result
	}
}

func (n *Node) handleDeliver(c *nodeConn, frame Frame) {
	reply := func(status, reason string) {
		c.send(Frame{Type: FrameDeliverResult, MessageID: frame.MessageID, Status: status, Reason: reason})
	}
	if frame.Message == nil {
		reply(StatusRejected, ReasonInvalid)
		return
	}
	msg := *frame.Message
	frame.MessageID = msg.MessageID
	if err := msg.Validate(); err != nil || msg.To != n.id {
		reply(StatusRejected, ReasonInvalid)
		return
	}
	n.mu.Lock()
	if _, seen := n.seen[msg.MessageID]; seen {
		n.mu.Unlock()
		reply(StatusAccepted, "")
		return
	}
	if n.inflight[msg.MessageID] {
		// Another Console is delivering the same message; let the sender retry and find it seen.
		n.mu.Unlock()
		reply(StatusUnreachable, "")
		return
	}
	if n.takeReplyLocked(msg) {
		n.seen[msg.MessageID] = n.opts.Now().UTC()
		n.saveSeenLocked()
		n.mu.Unlock()
		reply(StatusAccepted, "")
		return
	}
	slot := n.handler
	if slot == nil || slot.handle == nil {
		n.mu.Unlock()
		reply(StatusRejected, ReasonNoHandler)
		return
	}
	n.inflight[msg.MessageID] = true
	n.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), handlerTimeout)
	err := slot.handle(ctx, msg)
	cancel()

	n.mu.Lock()
	delete(n.inflight, msg.MessageID)
	if err == nil {
		n.seen[msg.MessageID] = n.opts.Now().UTC()
		n.saveSeenLocked()
	}
	n.mu.Unlock()
	if err != nil {
		var reject *RejectError
		reason := ReasonHandlerErr
		if errors.As(err, &reject) && strings.TrimSpace(reject.Reason) != "" {
			reason = reject.Reason
		}
		n.logger.Warn("agentlink_deliver_rejected", "message_id", msg.MessageID, "from", msg.From, "reason", reason, "error", err.Error())
		reply(StatusRejected, reason)
		return
	}
	reply(StatusAccepted, "")
}

func (n *Node) dispatchLoop(ctx context.Context) {
	defer n.dispatchers.Done()
	ticker := time.NewTicker(dispatchInterval)
	defer ticker.Stop()
	for {
		n.dispatch()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-n.kick:
		}
	}
}

func (n *Node) dispatch() {
	now := n.opts.Now()
	var expired []string
	n.mu.Lock()
	entries := make([]*outboxEntry, 0, len(n.outbox))
	for _, entry := range n.outbox {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].CreatedAt.Before(entries[j].CreatedAt) })
	for _, entry := range entries {
		if !now.Before(entry.ExpiresAt) {
			expired = append(expired, entry.Message.MessageID)
			continue
		}
		if entry.lease != nil {
			if now.Before(entry.leaseUntil) {
				continue
			}
			entry.lease = nil
			entry.leaseID = ""
			n.backoffLocked(entry)
		}
		if now.Before(entry.notBefore) {
			continue
		}
		candidates := make([]*nodeConn, 0, len(n.conns))
		for c := range n.conns {
			if _, ok := c.roster[entry.Message.To]; ok {
				candidates = append(candidates, c)
			}
		}
		if len(candidates) == 0 {
			continue
		}
		// Spread retries over the Consoles that reach the target.
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].seq < candidates[j].seq })
		c := candidates[entry.attempts%len(candidates)]
		msg := entry.Message
		leaseID := uuid.NewString()
		if !c.send(Frame{Type: FrameSend, LeaseID: leaseID, MessageID: msg.MessageID, Message: &msg}) {
			continue
		}
		entry.lease = c
		entry.leaseID = leaseID
		entry.leaseUntil = now.Add(n.opts.LeaseTimeout)
	}
	n.mu.Unlock()
	for _, id := range expired {
		n.finish(id, SendResult{MessageID: id, Status: StatusExpired})
	}
}

func (n *Node) outboxDir() string { return filepath.Join(n.dir, "outbox") }

func (n *Node) entryPath(messageID string) string {
	return filepath.Join(n.outboxDir(), safeFileName(messageID)+".json")
}

func (n *Node) writeEntry(entry *outboxEntry) error {
	return fsstore.WriteJSONAtomic(n.entryPath(entry.Message.MessageID), entry, fsstore.FileOptions{})
}

func (n *Node) loadOutbox() error {
	items, err := os.ReadDir(n.outboxDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".json") {
			continue
		}
		var entry outboxEntry
		path := filepath.Join(n.outboxDir(), item.Name())
		ok, err := fsstore.ReadJSON(path, &entry)
		if err != nil || !ok || entry.Message.Validate() != nil || entry.Message.From != n.id {
			n.logger.Warn("agentlink_outbox_entry_skipped", "path", path)
			continue
		}
		n.outbox[entry.Message.MessageID] = &entry
	}
	return nil
}

type seenFile struct {
	Messages map[string]time.Time `json:"messages"`
}

func (n *Node) seenPath() string { return filepath.Join(n.dir, "seen.json") }

func (n *Node) loadSeen() error {
	var file seenFile
	if _, err := fsstore.ReadJSON(n.seenPath(), &file); err != nil {
		n.logger.Warn("agentlink_seen_load_error", "error", err.Error())
		return nil
	}
	for id, at := range file.Messages {
		n.seen[id] = at
	}
	return nil
}

func (n *Node) saveSeenLocked() {
	cutoff := n.opts.Now().Add(-seenRetention)
	for id, at := range n.seen {
		if at.Before(cutoff) {
			delete(n.seen, id)
		}
	}
	if len(n.seen) > maxSeenEntries {
		ids := make([]string, 0, len(n.seen))
		for id := range n.seen {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return n.seen[ids[i]].Before(n.seen[ids[j]]) })
		for _, id := range ids[:len(ids)-maxSeenEntries] {
			delete(n.seen, id)
		}
	}
	if err := fsstore.WriteJSONAtomic(n.seenPath(), seenFile{Messages: n.seen}, fsstore.FileOptions{}); err != nil {
		n.logger.Warn("agentlink_seen_save_error", "error", err.Error())
	}
}

func safeFileName(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

var shared = struct {
	sync.Mutex
	nodes map[string]*Node
}{nodes: map[string]*Node{}}

// Shared returns the process's node for opts.StateDir, opening it on first use. Later calls return
// the same node and ignore the other options.
func Shared(opts Options) (*Node, error) {
	key := filepath.Clean(strings.TrimSpace(opts.StateDir))
	if strings.TrimSpace(opts.StateDir) == "" {
		return nil, fmt.Errorf("state dir is required")
	}
	shared.Lock()
	defer shared.Unlock()
	if node := shared.nodes[key]; node != nil {
		return node, nil
	}
	node, err := NewNode(opts)
	if err != nil {
		return nil, err
	}
	shared.nodes[key] = node
	return node, nil
}

// Lookup returns the process's node for stateDir, if one is open.
func Lookup(stateDir string) (*Node, bool) {
	key := filepath.Clean(strings.TrimSpace(stateDir))
	shared.Lock()
	defer shared.Unlock()
	node := shared.nodes[key]
	return node, node != nil
}
